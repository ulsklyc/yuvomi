/**
 * Budget-UI-Verträge (UX/UI-Audit Budget-Modul).
 *
 * Pinnt die Invarianten der Audit-Fixes fest, damit sie nicht stillschweigend
 * zurückfallen: eine Quelle für Monatsnavigation/Neu-Aktion je Untertab, das
 * Datum neuer Einträge folgt dem angezeigten Monat, Tab-Leisten tragen echtes
 * ARIA, Charts haben Textalternativen, keine Farb- oder Textliterale im JS.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { withoutHtmlComments } from './source-text.js';
import { eachRule } from './css-rules.js';

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8').replace(/\r/g, '');

const budget = read('../public/pages/budget.js');
const stats = read('../public/pages/budget-stats.js');
const plans = read('../public/pages/budget-plans.js');
const subscriptions = read('../public/pages/subscriptions.js');
const splitExpenses = read('../public/pages/split-expenses.js');
const housekeeping = read('../public/pages/housekeeping.js');
const money = read('../public/utils/money.js');
const layoutCss = read('../public/styles/layout.css');
const tokensCss = read('../public/styles/tokens.css');
const budgetCss = read('../public/styles/budget.css');
// Die geteilten Auswertungs-Bauteile (.panel-head, .segmented, .metric-grid,
// .metric-card) stehen seit der Namensbereinigung in panel.css - sie sind
// app-weites Vokabular, kein Budget-Baustein. Die Kompaktstufen, die am
// Container der Budget-Seite haengen, stehen weiter in budget.css.
const panelCss = read('../public/styles/panel.css');
const subscriptionsCss = read('../public/styles/subscriptions.css');
const splitCss = read('../public/styles/split-expenses.css');

// Fuer den Verhaltenstest des Zeitraum-Kopfs (#1164) wird budget.js WIRKLICH
// geladen (Browser-Loader, siehe npm-Skript), statt nur als Text gelesen -
// geprueft werden gerendertes Markup und die echte Sync-Funktion. budget.js
// zieht am Modulkopf echte Browser-Module (u. a. das Custom Element
// category-manager.js); der Minimal-Stub deckt genau deren Modul-Ladezeit ab,
// dasselbe Muster wie test-waste-ui.js/test-shopping-ux.js. Er steht VOR dem
// ersten Top-Level-await: unter Node 22 beginnen registrierte Tests dort schon
// zu laufen, und alles, was sie brauchen, muss dann initialisiert sein.
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
const { todayKey } = await import('../public/utils/date.js');

// --------------------------------------------------------
// Monatsnavigation und Neu-Aktion je Untertab
// --------------------------------------------------------

test('TAB_CAPS ist die einzige Quelle für Monatsnavigation und Neu-Aktion', () => {
  const table = budget.match(/const TAB_CAPS = \{[\s\S]*?\n\};/);
  assert.ok(table, 'TAB_CAPS-Tabelle fehlt');

  // Jeder Tab der Leiste muss einen Eintrag haben, sonst fällt er auf den
  // Budget-Default zurück und bekommt stillschweigend fremde Bedienelemente.
  for (const id of ['budget', 'accounts', 'plan', 'subscriptions', 'loans', 'reports', 'split-expenses']) {
    assert.match(table[0], new RegExp(`'${id}':`), `TAB_CAPS ohne Eintrag für '${id}'`);
  }

  // Zeitbezug nur dort, wo der Zeitraum den Inhalt bestimmt. Berichte tragen ihn
  // seit der Zusammenführung mit — sie hatten vorher einen eigenen Stepper.
  for (const id of ['budget', 'plan', 'reports']) {
    assert.match(table[0], new RegExp(`'${id}':\\s*\\{ month: true`), `'${id}' braucht den Kopf-Stepper`);
  }
  for (const id of ['accounts', 'subscriptions', 'loans', 'split-expenses']) {
    assert.match(table[0], new RegExp(`'${id}':\\s*\\{ month: false`), `'${id}' darf keine Monatsnavigation zeigen`);
  }

  // Berichte kennt keine Neu-Aktion — dort bleiben Toolbar-Button und FAB weg.
  assert.match(table[0], /'reports':\s*\{ month: true,\s*range: true,\s*add: null/);
});

test('der Kopf-Slot bleibt auf jedem Tab besetzt', () => {
  // Eine Lücke im Kopf las sich als „der zuletzt gewählte Monat gilt weiter".
  // Regel statt Aufzählung: jeder Tab ohne Stepper braucht einen Kontexttext.
  const table = budget.match(/const TAB_CAPS = \{[\s\S]*?\n\};/);
  for (const entry of table[0].matchAll(/'([a-z-]+)':\s*\{([^}]*)\}/g)) {
    const [, id, caps] = entry;
    if (/month:\s*true/.test(caps)) continue;
    assert.match(caps, /note:\s*'budget\.periodNote/, `'${id}' hat weder Stepper noch Kontexttext`);
  }
  // Und der Kontexttext wird auch wirklich geschaltet.
  assert.match(budget, /note\.hidden = !caps\.note/);
  assert.match(budget, /note\.textContent = t\(caps\.note\)/);
});

test('Monats-Bedienelemente werden als Block geschaltet, nicht einzeln', () => {
  // Der frühere Bug: prev/next versteckt, Label und "Aktuell" blieben stehen.
  const block = budget.match(/\['#budget-prev', '#budget-next', '#budget-today', '#budget-label'\][\s\S]{0,220}/);
  assert.ok(block, 'Monats-Bedienelemente werden nicht gemeinsam geschaltet');
  assert.match(block[0], /el\.hidden = !caps\.month/);
});

// Fake-Knopf mit einer echten (Set-gestuetzten) classList und einem
// `inert`-Feld - genug DOM-Oberflaeche, um `.is-current` und `inert` wie im
// echten Browser zu pruefen, ohne eine ganze DOM-Bibliothek zu laden.
function fakeResetButton() {
  const classes = new Set();
  return {
    inert: false,
    classList: {
      toggle(cls, force) { if (force) classes.add(cls); else classes.delete(cls); },
      contains(cls) { return classes.has(cls); },
    },
  };
}

// #1164: EIN Positions- und EINE Sichtbarkeitsregel fuer den Zeitraum-Reset.
// Verhaltensgetrieben: geprueft werden der GERENDERTE Kopf und die echte
// Sync-Funktion, nicht der Quelltext.
//
// PR #1200 Review, Blocking 1: `hidden` loeste in `display: none` auf und nahm
// die Box aus dem Fluss - das Nachbar-Label (`flex: 1`) wuchs dann in den frei
// gewordenen Platz und "›" ruckte um die Knopfbreite, sobald der Reset
// erschien/verschwand (gemessen 11/11 im Budget ueber 33 Layouts, das
// schlimmste der drei Module). Ersetzt durch `.is-current` (visibility, Box
// bleibt im Fluss) + `inert` (Zeiger/Fokus/A11y-Baum). Dieser Test pinnt jetzt
// GENAU DIESEN Mechanismus fest: eine Rueckkehr zu `hidden` (oder ein
// Vergessen von `inert`) faellt hier durch.
test('Zeitraum-Kopf: zurueck, Wert, vor - dahinter „Aktuell", per .is-current+inert verborgen im aktuellen Zeitraum (#1164, #1200)', () => {
  // (a) Reihenfolge im gerenderten Markup: der Reset steht HINTER dem Stepper.
  const ids = [...budgetUi.monthNavHtml().matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(
    ids,
    ['budget-prev', 'budget-label', 'budget-next', 'budget-today', 'budget-period-note'],
    'erwartet zurueck, Wert, vor, Reset (und den Kontexttext-Slot)'
  );

  // (b) Sichtbarkeit: im aktuellen Monat bzw. auf dem heutigen Berichts-Anker
  // traegt der Reset `.is-current` und `inert`, behaelt aber sein Element (der
  // Slot bleibt reserviert, "›"/"‹" wandern nicht).
  const btn = fakeResetButton();
  const prevBtn = fakeResetButton();
  const root = {
    querySelector: (sel) => (sel === '#budget-today' ? btn : sel === '#budget-prev' ? prevBtn : null),
  };
  const zuvor = {
    activeTab: budgetUi.state.activeTab,
    month: budgetUi.state.month,
    reportAnchor: budgetUi.state.reportAnchor,
    range: budgetUi.state.range,
    reportRangeFrom: budgetUi.state.reportRangeFrom,
    reportRangeTo: budgetUi.state.reportRangeTo,
  };
  try {
    budgetUi.state.activeTab = 'budget';
    budgetUi.state.month = budgetUi.currentMonth();
    budgetUi.syncCurrentButton(root);
    assert.equal(btn.classList.contains('is-current'), true, 'im aktuellen Monat muss der Reset .is-current tragen');
    assert.equal(btn.inert, true, 'im aktuellen Monat muss der Reset inert sein');
    budgetUi.state.month = '2030-06';
    budgetUi.syncCurrentButton(root);
    assert.equal(btn.classList.contains('is-current'), false, 'in einem anderen Monat darf der Reset nicht .is-current sein');
    assert.equal(btn.inert, false, 'in einem anderen Monat darf der Reset nicht inert sein');

    // Berichte rechnen per CONTAINMENT (Befund 4), nicht Ankergleichheit: ein
    // Anker auf dem Monatsersten zeigt trotzdem "aktuell", solange der
    // angezeigte Monat den heutigen Tag enthaelt.
    budgetUi.state.activeTab = 'reports';
    budgetUi.state.range = 'month';
    budgetUi.state.reportAnchor = '2030-06-01';
    budgetUi.syncCurrentButton(root);
    assert.equal(btn.classList.contains('is-current'), false, 'Berichte/Monat: ein fremder Monat zeigt den Reset');
    budgetUi.state.reportAnchor = budgetUi.currentMonth() + '-01';
    budgetUi.syncCurrentButton(root);
    assert.equal(
      btn.classList.contains('is-current'), true,
      'Berichte/Monat: der Anker auf dem Monatsersten des LAUFENDEN Monats muss trotzdem als aktuell gelten (Befund 4 - Ankergleichheit versagte hier)'
    );

    budgetUi.state.range = 'year';
    budgetUi.state.reportAnchor = '2030-06-15';
    budgetUi.syncCurrentButton(root);
    assert.equal(btn.classList.contains('is-current'), false, 'Berichte/Jahr: ein fremdes Jahr zeigt den Reset');
    budgetUi.state.reportAnchor = todayKey();
    budgetUi.syncCurrentButton(root);
    assert.equal(btn.classList.contains('is-current'), true, 'Berichte/Jahr: das laufende Jahr verbirgt den Reset');

    budgetUi.state.range = 'week';
    budgetUi.state.reportAnchor = todayKey();
    budgetUi.state.reportRangeFrom = '2020-01-06';
    budgetUi.state.reportRangeTo = '2020-01-12';
    budgetUi.syncCurrentButton(root);
    assert.equal(
      btn.classList.contains('is-current'), false,
      'Berichte/Woche: eine gemeldete Serverwoche, die heute nicht enthaelt, zeigt den Reset'
    );
    budgetUi.state.reportRangeFrom = todayKey();
    budgetUi.state.reportRangeTo = todayKey();
    budgetUi.syncCurrentButton(root);
    assert.equal(
      btn.classList.contains('is-current'), true,
      'Berichte/Woche: enthaelt die gemeldete Serverwoche heute, ist der Reset verborgen'
    );

    // Und der Tab-Block behaelt das letzte Wort: ohne Monatsnavigation bleibt
    // der Reset verborgen, egal welcher Monat eingestellt ist.
    budgetUi.state.activeTab = 'accounts';
    budgetUi.state.month = '2030-06';
    btn.classList.toggle('is-current', false);
    btn.inert = false;
    budgetUi.syncCurrentButton(root);
    assert.equal(btn.classList.contains('is-current'), true, 'ohne Monatsnavigation bleibt der Reset .is-current');
    assert.equal(btn.inert, true, 'ohne Monatsnavigation bleibt der Reset inert');
  } finally {
    Object.assign(budgetUi.state, zuvor);
  }
});

// PR #1200 Review, Should-fix 3: Enter auf „Aktuell" laed den heutigen
// Zeitraum, macht den (fokussierten) Knopf damit selbst inert - ohne
// Gegenmassnahme faellt der Fokus auf `<body>`. syncCurrentButton() muss den
// Fokus VORHER auf den Vorherige-Periode-Pfeil legen.
test('syncCurrentButton() rettet den Fokus vor dem eigenen inert-Werden', () => {
  const btn = fakeResetButton();
  const prevBtn = fakeResetButton();
  const root = {
    querySelector: (sel) => (sel === '#budget-today' ? btn : sel === '#budget-prev' ? prevBtn : null),
  };
  const zuvor = { activeTab: budgetUi.state.activeTab, month: budgetUi.state.month };
  const zuvorDocument = global.document;
  try {
    global.document = { ...zuvorDocument, activeElement: btn };
    budgetUi.state.activeTab = 'budget';
    budgetUi.state.month = '2030-06'; // erst NICHT aktuell, Knopf ist sichtbar+fokussierbar
    budgetUi.syncCurrentButton(root);
    assert.equal(btn.inert, false);

    let fokussiert = false;
    prevBtn.focus = () => { fokussiert = true; global.document.activeElement = prevBtn; };
    budgetUi.state.month = budgetUi.currentMonth(); // jetzt wird der fokussierte Knopf aktuell
    budgetUi.syncCurrentButton(root);
    assert.equal(fokussiert, true, 'der Fokus muss vor dem inert-Werden auf den Vorherige-Pfeil wandern');
    assert.equal(btn.inert, true);
  } finally {
    Object.assign(budgetUi.state, zuvor);
    global.document = zuvorDocument;
  }
});

// Minimales Fake-Element fuer Knoten, die `updateTabs()` neben dem Reset
// noch anfasst (#budget-body, #budget-prev/-next/-label, #budget-period-note,
// #budget-add): `hidden`, `textContent`, `setAttribute`, eine leere
// `querySelector()` (fuer `addBtn.querySelector('.toolbar-new-btn__label')`).
function fakeToolbarElement() {
  return {
    hidden: false,
    textContent: '',
    setAttribute() {},
    querySelector() { return null; },
  };
}

// PR #1200 Review Runde 3, Nice-to-have 1: der bisherige Test las
// `updateTabs()` als QUELLTEXT (Regex auf den Funktionskoerper) - ein
// `if (false) syncCurrentButton();` im echten Render-Pfad blieb gruen,
// solange der String noch irgendwo im Funktionskoerper stand. Dieser Test
// laesst den ECHTEN Render-Pfad laufen: `updateTabsForTest()` setzt den
// Modul-internen Container auf einen Test-Container und ruft `updateTabs()`
// unveraendert auf; geprueft wird das SICHTBARE ERGEBNIS am echten
// `#budget-today`-Knoten, nicht der Quelltext.
test('updateTabs() verdrahtet syncCurrentButton() wirklich in den Render-Pfad', () => {
  const todayBtn = fakeResetButton();
  const testContainer = {
    classList: { toggle() {} },
    querySelector(sel) {
      if (sel === '#budget-today') return todayBtn;
      return fakeToolbarElement();
    },
  };
  const zuvorTab = budgetUi.state.activeTab;
  const zuvorMonth = budgetUi.state.month;
  try {
    budgetUi.state.activeTab = 'budget'; // TAB_CAPS['budget']: month: true
    budgetUi.state.month = budgetUi.currentMonth(); // aktueller Monat -> is-current
    budgetUi.updateTabsForTest(testContainer);
    assert.equal(todayBtn.classList.contains('is-current'), true,
      'updateTabs() muss syncCurrentButton() wirklich aufrufen - der Reset traegt im aktuellen Monat sonst kein .is-current');
  } finally {
    budgetUi.state.activeTab = zuvorTab;
    budgetUi.state.month = zuvorMonth;
  }
});

// PR #1200 Review, Befund 5: monthNavHtml() rendert den Reset ohne
// .is-current/inert, und ohne diese Gegenmassnahme blitzt er bei jedem
// frischen Laden von /budget sichtbar auf, bevor renderBody() ihn nach dem
// ersten Laden wieder korrekt einstellt.
test('render() synchronisiert „Aktuell" VOR dem ersten Laden, gegen das Aufblitzen (Befund 5)', () => {
  const renderStart = budget.indexOf('export async function render(container, { user }) {');
  const loadIdx = budget.indexOf('await Promise.all([loadMonth(state.month), loadAccounts()]);');
  assert.ok(renderStart > -1 && loadIdx > -1, 'render()/Promise.all-Aufruf nicht gefunden');
  const syncIdx = budget.indexOf('syncCurrentButton();', renderStart);
  assert.ok(syncIdx > -1 && syncIdx < loadIdx,
    'syncCurrentButton() muss zwischen dem Beginn von render() und dem ersten Laden aufgerufen werden');
});

test('das Modul führt genau eine Zeitachse', () => {
  // Vorher hielt budget-stats.js einen eigenen anchor: Budget auf März gestellt,
  // Wechsel auf Berichte zeigte Juli. Der Anker lebt jetzt im Modul-State und
  // wird beim Tabwechsel in beide Richtungen angeglichen.
  // Seit #829 Teil 3 heisst die Frage nach dem heutigen Tag `todayKey()` - sie
  // folgt der Haushaltszone, waehrend `toLocalDateKey` der reine Konverter blieb.
  // Die Zusicherung ist dieselbe: der Anker startet auf heute.
  assert.match(budget, /reportAnchor:\s*todayKey\(\)/);
  assert.match(budget, /state\.reportAnchor = anchorForMonth\(state\.month\)/, 'Hinweg Budget → Berichte fehlt');
  assert.match(budget, /const ym = state\.reportAnchor\.slice\(0, 7\)/, 'Rückweg Berichte → Budget fehlt');

  // Das Panel darf keinen eigenen Zeitraumwähler mehr aufbauen.
  assert.doesNotMatch(stats, /data-step=/, 'budget-stats.js baut wieder einen zweiten Stepper');
  assert.doesNotMatch(stats, /budget-stats__period/, 'der Zeitraum gehört in den geteilten Kopf');
  assert.match(stats, /view\.anchor = ctx\.anchor/, 'der Anker muss vom Modul kommen');
  assert.match(stats, /view\.ctx\.onRangeChange\(id\)/, 'die Auflösung muss ans Modul zurückgemeldet werden');
});

test('Toolbar-Aktion und FAB teilen sich Sichtbarkeit und Label', () => {
  // Beide lesen DIESELBE Variable `add` (TAB_CAPS plus Archiv-Sperre der
  // Aufteilung, syncAddAction) - nicht jeder seine eigene Bedingung.
  assert.match(budget, /const add = splitBlocked \? null : caps\.add;/);
  assert.match(budget, /const addLabel = add \? t\(add\) : ''/);
  assert.match(budget, /addBtn\.hidden = !add;/);
  assert.match(budget, /fab\.hidden = !add;/);
  // Kein Rückfall auf die alten Ausschluss-Listen.
  assert.doesNotMatch(budget, /splitActive \|\| subscriptionsActive/);
});

test('hidden greift bei geteilten Bedienelementen trotz display-Klasse', () => {
  // `.page-fab { display:flex }` bzw. `.btn { display:inline-flex }` schlagen
  // das UA-`[hidden]` bei gleicher Spezifität — ohne Guard bleibt der FAB auf
  // dem Berichte-Tab sichtbar. Seit UX-Audit R2 deckt der Guard auch
  // `.form-group` ab (RRULE-Endefelder, Audit A1-10).
  //
  // `[^{}]*\{` statt eines Zeichenabstands: geprüft werden soll, dass Selektor
  // und Deklaration im SELBEN Regelblock stehen - kein `}` und kein zweites `{`
  // dazwischen. Das frühere `[\s\S]{0,120}` maß stattdessen die Länge der
  // Selektorliste und schlug damit bei jeder legitimen Ergänzung an; die Liste ist
  // aber ausdrücklich zum Wachsen gedacht (bei `.list-bulkbar` war sie 141
  // Zeichen lang und der Guard rot, obwohl die Struktur korrekt war).
  const sameBlock = (selector) => new RegExp(`${selector}[^{}]*\\{\\s*display:\\s*none\\s*!important`);
  // `.list-bulkbar` stand hier, solange sie ein dauerhafter, leerer Knoten im
  // Seitenfluss war. Seit Etappe 5 wird sie angelegt und entfernt
  // (utils/bulk-pill.js) und trägt nie `hidden` - ein Eintrag für einen
  // Zustand, den niemand setzt, prüft nichts.
  for (const selector of ['\\.page-fab\\[hidden\\]', '\\.btn\\[hidden\\]', '\\.form-group\\[hidden\\]']) {
    assert.match(layoutCss, sameBlock(selector), `${selector} steht nicht im Durchsetzungsblock`);
  }
});

// --------------------------------------------------------
// Datum neuer Einträge
// --------------------------------------------------------

test('neue Einträge landen im angezeigten Monat, nicht im heutigen', () => {
  // GEPRÜFT WIRD DIE HERKUNFT, NICHT DIE SCHREIBWEISE. Die Vorgängerfassung
  // verlangte die Zeile buchstabengetreu
  // (`state.month === todayMonth ? today : ...`) und schlug deshalb an, als die
  // Regel unverändert nach utils/date.js zog - ein Guard, der ein Refactoring
  // ohne Verhaltensänderung als Verstoß meldet, hat die falsche Ebene.
  // Verlangt wird jetzt: der Standardwert stammt aus der hausweiten Regel,
  // angewandt auf den angezeigten Monat.
  assert.match(budget, /defaultDateInPeriod/,
    'das Standarddatum kommt nicht mehr aus defaultDateInPeriod() (utils/date.js)');
  assert.match(budget, /monthPeriodKeys\(state\.month\)/,
    'der Zeitraum ist nicht mehr der angezeigte Monat');
  assert.match(budget, /const defaultDate = defaultDateInPeriod\(/,
    'defaultDate wird nicht mehr aus der Regel abgeleitet');
  // Das Datumsfeld muss den abgeleiteten Wert nutzen, nicht mehr `today`.
  assert.match(budget, /id="bm-date"\s*\n?\s*value="\$\{isEdit \? entry\.date : defaultDate\}"/);
  assert.doesNotMatch(budget, /id="bm-date"[\s\S]{0,80}entry\.date : today\}/);
});

// --------------------------------------------------------
// Tab-Leisten und Filter-ARIA
// --------------------------------------------------------

test('keine Umschalter-Leiste im Modul versteckt sich hinter role="group"', () => {
  // REGEL statt Allowlist. Die Vorgängerfassung nannte drei Selektoren
  // (.budget-tabs, .budget-scope, .budget-stats__ranges) und übersah damit genau
  // die beiden Leisten, die role="group" trugen und ohne Pfeiltasten-Navigation
  // dastanden - Darlehensstatus und Gruppenstatus. Eine Allowlist deckt N
  // Dateien ab, nicht die Regel.
  //
  // Die Regel: wer eine Auswahl anbietet, benennt sie auch so. role="group" ist
  // ein Sammelbehälter ohne Auswahlsemantik; Leisten gehören auf role="tablist"
  // (Sichtwechsel) oder role="radiogroup" (Einfachauswahl) - und landen damit
  // automatisch im Guard darunter.
  for (const [file, src] of BUDGET_PAGES) {
    for (const bar of withoutComments(src).matchAll(/role="group"[\s\S]{0,900}?<\/div>/g)) {
      assert.doesNotMatch(
        bar[0],
        /aria-selected=|aria-pressed=|aria-checked=/,
        `${file}: eine Leiste mit role="group" meldet einen Auswahlzustand - `
        + 'role="tablist" (Sicht) oder role="radiogroup" (Wert) benennt das richtig',
      );
    }
  }
});

test('jede Umschalter-Leiste des Moduls läuft durch die geteilte Verhaltensschicht', () => {
  // Ohne wireTablist gibt es Roving-Tabindex ohne Pfeiltasten — eine Falle, aus
  // der Tastaturnutzer nicht mehr herauskommen. Der Guard leitet die Leisten aus
  // dem Markup ab, statt sie aufzuzählen: eine neue Leiste ist automatisch erfasst.
  const wired = BUDGET_PAGES.flatMap(([, src]) =>
    [...src.matchAll(/wireTablist\(\s*[^)]*?querySelector\('([^']+)'\)/g)].map((m) => m[1]));

  for (const [file, src] of BUDGET_PAGES) {
    for (const bar of src.matchAll(/<div class="([^"]+)"([^>]*)role="(tablist|radiogroup)"/g)) {
      const [, classes, attrs] = bar;
      const id = attrs.match(/id="([^"]+)"/)?.[1];
      const selectors = [...classes.trim().split(/\s+/).map((c) => `.${c}`), ...(id ? [`#${id}`] : [])];
      assert.ok(
        selectors.some((s) => wired.includes(s)),
        `${file}: Leiste "${classes}" ist an keinem wireTablist verdrahtet (${selectors.join(' / ')})`,
      );
    }
  }
  // Der Scope-Umschalter muss dafür data-tab-id tragen (nicht mehr data-scope).
  assert.doesNotMatch(budget, /data-scope=/);
});

test('es gibt genau eine Umschalter-Optik im Modul', () => {
  // Vier Optiken für dieselbe Frage - getönte Kapsel, eckig gefülltes Rechteck,
  // weiße Kachel, umrandete Pille - hießen, dass derselbe Zustand pro Tab anders
  // aussah. .segmented ist der Baustein; wer eine Leiste baut, greift ihn.
  assert.ok(/\n\.segmented\s*\{/.test(panelCss), '.segmented fehlt in panel.css');
  assert.ok(/\n\.segmented__item\s*\{/.test(panelCss), '.segmented__item fehlt');

  for (const [file, src] of BUDGET_PAGES) {
    for (const bar of src.matchAll(/<div class="([^"]+)"([^>]*)role="(tablist|radiogroup)"/g)) {
      const [, classes] = bar;
      // Die Haupt-Tabs und der Scope-Umschalter tragen die app-weite Pillen-
      // Grammatik (sub-tabs.css) - sie sitzen in der Toolbar, nicht im Panel.
      if (/budget-tabs|budget-scope|budget-color-picker/.test(classes)) continue;
      assert.match(
        classes,
        /segmented/,
        `${file}: Leiste "${classes}" baut eine eigene Optik statt .segmented`,
      );
    }
  }

  // Und die abgelösten Optiken kommen nicht zurück.
  const liveCss = withoutComments(budgetCss);
  for (const dead of ['budget-loans__filter\\b', 'budget-stats__range\\b']) {
    assert.doesNotMatch(liveCss, new RegExp(`\\.${dead}`), `.${dead} ist durch .segmented ersetzt`);
  }
});

test('das Touch-Maß der Umschalter kommt aus dem Token, nicht aus der Leiste', () => {
  // Die abgelösten Leisten lagen bei 40px (Zeitraum) und 28px (Nur-Ausgaben).
  const item = panelCss.match(/\n\.segmented__item\s*\{([^}]*)\}/);
  assert.ok(item, '.segmented__item fehlt');
  assert.match(item[1], /min-height:\s*var\(--target-base\)/);
});

test('Auflösungs-Umschalter der Berichte trägt echtes Tab-ARIA', () => {
  const bar = stats.match(/class="[^"]*budget-stats__ranges"[\s\S]*?<\/div>/);
  assert.ok(bar, 'Auflösungs-Leiste nicht gefunden');
  assert.match(bar[0], /role="tablist"/);
  assert.match(bar[0], /aria-label=/);
  assert.match(stats, /role="tab"[\s\S]{0,140}aria-selected="\$\{on\}"/);
  assert.match(stats, /tabindex="\$\{on \? '0' : '-1'\}"/);
});

test('Einfachauswahl-Leisten melden ihren Zustand über aria-checked', () => {
  // Darlehensstatus, Gruppenstatus und Kontofarbe wählen EINEN Wert, sie
  // wechseln keine Sicht: aria-checked in einer radiogroup, nicht aria-pressed
  // in einem role="group". Der Zustand muss angesagt werden - reine Einfärbung
  // ist für Screenreader kein Kanal.
  assert.match(budget, /role="radio" data-tab-id="\$\{id\}" aria-checked="\$\{on\}"/, 'Darlehensstatus');
  assert.match(splitExpenses, /role="radio" data-tab-id="\$\{id\}" aria-checked="\$\{on\}"/, 'Gruppenstatus');
  assert.match(budget, /role="radio"[\s\S]{0,200}aria-checked="\$\{on\}"/, 'Kontofarbe');
  // Der Filter-Trichter je Darlehenszeile bleibt ein einzelner Toggle-Button.
  assert.match(budget, /data-action="loan-filter"[\s\S]{0,160}aria-pressed=/);
});

// --------------------------------------------------------
// Charts: Textalternative, Palette, Achsen
// --------------------------------------------------------

test('Trendkurve und Donut haben eine Textalternative mit Werten', () => {
  // Rein visuelle Diagramme ohne sr-only-Zusammenfassung sind für
  // Screenreader-Nutzer leer — der Budget-Tab macht es mit chartSummary vor.
  assert.match(budget, /class="sr-only">\$\{esc\(chartSummary/);
  assert.match(stats, /statsTrendSummary/);
  assert.match(stats, /statsDonutSummary/);
  assert.match(stats, /<p class="sr-only">\$\{view\.ctx\.esc\(summary\)\}<\/p>/);
  // Die SVGs selbst sind dann dekorativ und dürfen nicht doppelt angesagt werden.
  assert.match(stats, /class="budget-stats__trend"[\s\S]{0,120}aria-hidden="true"/);
  assert.match(stats, /class="budget-stats__donut" aria-hidden="true"/);
});

test('Donut-Palette wiederholt keine Farbe und borgt keine Modul-Akzente', () => {
  const palette = stats.match(/const DONUT_COLORS = \[[\s\S]*?\];/);
  assert.ok(palette, 'DONUT_COLORS fehlt');
  assert.doesNotMatch(palette[0], /--module-/, 'Modul-Akzente tragen eine andere Bedeutung');
  const colors = [...palette[0].matchAll(/--chart-series-\d/g)].map((m) => m[0]);
  assert.equal(new Set(colors).size, colors.length, 'doppelte Farbe in der Palette');
  // Segmente über die Palettengröße hinaus werden gebündelt statt eingefärbt.
  assert.match(stats, /const DONUT_SEGMENTS = DONUT_COLORS\.length/);
  assert.match(stats, /statsOtherCategories/);
  assert.match(stats, /stroke="\$\{DONUT_COLORS\[i\]\}"/, 'kein Modulo-Recycling mehr');
});

test('die Datenreihen-Tokens existieren in beiden Themes', () => {
  for (let i = 1; i <= 7; i++) {
    assert.match(tokensCss, new RegExp(`--chart-series-${i}:\\s*var\\(--_chart-series-${i}\\)`));
  }
  // Basis + zwei Dark-Blöcke (@media und [data-theme="dark"]).
  const defs = [...tokensCss.matchAll(/--_chart-series-1:/g)];
  assert.equal(defs.length, 3, 'Dark-Mode-Variante fehlt in einem der beiden Dark-Blöcke');
});

/**
 * Keine Datenreihe darf sich mit dem Modulton der Seite decken, die sie zeigt.
 *
 * WARUM DER GUARD DARÜBER NICHT GRIFF: der Nachbar oben („borgt keine
 * Modul-Akzente") prüft den NAMEN - dass kein `--module-*` in DONUT_COLORS
 * steht. Genau das war erfüllt, während `--_chart-series-2` seit dem
 * Familientoene-Umbau BUCHSTÄBLICH derselbe Hexwert war wie `--_family-money`
 * (#0F766E light, #2DD4BF dark) - der Modulton des Budgets, in dem die Palette
 * läuft. Ein Konto in „Türkis" war dort nicht vom Chrome zu unterscheiden. Der
 * Guard war grün und die Regel verletzt, weil er die falsche Ebene maß.
 * Gemessen wird deshalb der WERT, und zwar wahrnehmungsnah (CIEDE2000), nicht
 * per Stringvergleich: die nächste Deckung wäre sonst schon mit einem um 1
 * verschobenen Kanal wieder unsichtbar.
 *
 * WARUM ER NUR DIE CHART-NUTZENDEN MODULE PRÜFT: Serie 3 deckt sich mit
 * --_family-kitchen und Serie 7 mit --_family-work (dE 1.9), beide bewusst
 * stehengelassen - Küche und Aufgaben haben keine Diagramme, die Deckung ist
 * dort folgenlos. Das ist die Ausnahme MIT Verfallsdatum an beiden Enden:
 * bekommt eine Küchen- oder Aufgabenseite ein Diagramm, findet dieser Guard die
 * Serie im selben Lauf, ohne dass jemand daran denken muss. Guard-Ebene 2
 * (Struktur, aus deklarativer Quelle: router.js + tokens.css).
 */
test('keine Datenreihe deckt sich mit dem Modulton einer Seite, die Diagramme zeigt', () => {
  // 1. Welche Seiten beziehen die Palette überhaupt? Aus dem Quelltext, nicht
  //    aus einer Liste hier - eine Liste wäre wieder die Allowlist von oben.
  const pagesDir = new URL('../public/pages/', import.meta.url);
  const users = readdirSync(pagesDir)
    .filter((f) => f.endsWith('.js'))
    .filter((f) => read(`../public/pages/${f}`).includes('--chart-series-'));
  assert.ok(
    users.length >= 2,
    `Nur ${users.length} Seite(n) beziehen --chart-series-. Hat sich die Schreibweise geändert? `
    + 'Ein Guard über eine leere Menge sichert nichts zu.',
  );

  // 2. Modul je Seite aus der deklarativen Routentabelle.
  const router = read('../public/router.js');
  const moduleOf = new Map();
  for (const m of router.matchAll(/page:\s*'\/pages\/([^']+)'[^}]*?module:\s*'([^']+)'/g)) {
    moduleOf.set(m[1], m[2]);
  }
  const modules = [...new Set(users.map((f) => moduleOf.get(f)).filter(Boolean))];
  assert.ok(
    modules.length >= 1,
    `Keine der Chart-Seiten (${users.join(', ')}) fand ein Modul in router.js - der Guard misst dann nichts.`,
  );

  // 3. Modulton auflösen: --module-<name> zeigt auf eine Familie, die Familie
  //    trägt den Hexwert. Beide Ebenen kommen aus tokens.css.
  const familyOf = new Map();
  for (const m of tokensCss.matchAll(/--module-([\w-]+):\s*var\(--_family-([\w-]+)\)/g)) {
    familyOf.set(m[1], m[2]);
  }
  const valuesOf = (token) => [...tokensCss.matchAll(new RegExp(`${token}:\\s*(#[\\da-fA-F]{6})`, 'g'))].map((x) => x[1]);

  // 4. CIEDE2000 - der Abstand, den ein Auge sieht. Unter 2.3 (Just Noticeable
  //    Difference) sind zwei Farben derselbe Ton, egal was die Hexwerte sagen.
  const JND = 2.3;
  const lab = (value) => {
    const [r, g, b] = value.match(/[\da-f]{2}/gi)
      .map((p) => parseInt(p, 16) / 255)
      .map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
    const f = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
    const x = f((0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.95047);
    const y = f(0.2126 * r + 0.7152 * g + 0.0722 * b);
    const z = f((0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.08883);
    return [116 * y - 16, 500 * (x - y), 200 * (y - z)];
  };
  const deltaE = (one, two) => {
    const [L1, a1, b1] = lab(one);
    const [L2, a2, b2] = lab(two);
    const cBar = (Math.hypot(a1, b1) + Math.hypot(a2, b2)) / 2;
    const g = 0.5 * (1 - Math.sqrt(cBar ** 7 / (cBar ** 7 + 25 ** 7)));
    const [A1, A2] = [a1 * (1 + g), a2 * (1 + g)];
    const [C1, C2] = [Math.hypot(A1, b1), Math.hypot(A2, b2)];
    const angle = (x, y) => (x === 0 && y === 0 ? 0 : ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360);
    const [h1, h2] = [angle(A1, b1), angle(A2, b2)];
    const dL = L2 - L1;
    const dC = C2 - C1;
    let dh = 0;
    if (C1 * C2 !== 0) {
      dh = h2 - h1;
      if (dh > 180) dh -= 360;
      else if (dh < -180) dh += 360;
    }
    const dH = 2 * Math.sqrt(C1 * C2) * Math.sin((dh * Math.PI) / 360);
    const lBar = (L1 + L2) / 2;
    const cBarP = (C1 + C2) / 2;
    let hBar = h1 + h2;
    if (C1 * C2 !== 0 && Math.abs(h1 - h2) > 180) hBar += hBar < 360 ? 360 : -360;
    if (C1 * C2 !== 0) hBar /= 2;
    const rad = (deg) => (deg * Math.PI) / 180;
    const T = 1 - 0.17 * Math.cos(rad(hBar - 30)) + 0.24 * Math.cos(rad(2 * hBar))
      + 0.32 * Math.cos(rad(3 * hBar + 6)) - 0.20 * Math.cos(rad(4 * hBar - 63));
    const sL = 1 + (0.015 * (lBar - 50) ** 2) / Math.sqrt(20 + (lBar - 50) ** 2);
    const sC = 1 + 0.045 * cBarP;
    const sH = 1 + 0.015 * cBarP * T;
    const rT = -Math.sin(rad(60 * Math.exp(-(((hBar - 275) / 25) ** 2))))
      * 2 * Math.sqrt(cBarP ** 7 / (cBarP ** 7 + 25 ** 7));
    return Math.sqrt((dL / sL) ** 2 + (dC / sC) ** 2 + (dH / sH) ** 2 + rT * (dC / sC) * (dH / sH));
  };

  // Selbsttest: die Formel muss zwei gleiche Farben auf 0 und zwei klar
  // verschiedene weit über die Schwelle bringen. Ohne ihn wäre ein deltaE, das
  // immer 0 liefert, ein grüner Guard ohne Zusicherung.
  assert.equal(deltaE('#0F766E', '#0F766E'), 0, 'deltaE misst identische Farben nicht als 0');
  assert.ok(deltaE('#0F766E', '#C2410C') > 20, 'deltaE trennt Teal und Orange nicht');

  let checked = 0;
  for (const mod of modules) {
    const family = familyOf.get(mod);
    assert.ok(family, `--module-${mod} löst in tokens.css auf keinen Familienton auf`);
    const familyValues = valuesOf(`--_family-${family}`);
    assert.ok(familyValues.length >= 2, `--_family-${family} fehlt ein Theme-Wert`);

    for (const [themeIndex, theme] of [[0, 'light'], [1, 'dark']]) {
      for (let i = 1; i <= 7; i++) {
        const series = valuesOf(`--_chart-series-${i}`)[themeIndex];
        assert.ok(series, `--_chart-series-${i} fehlt für Theme ${theme}`);
        const distance = deltaE(series, familyValues[themeIndex]);
        checked++;
        assert.ok(
          distance >= JND,
          `${theme}: --chart-series-${i} (${series}) liegt ${distance.toFixed(1)} von `
          + `--_family-${family} (${familyValues[themeIndex]}) - der Modulton von "${mod}", `
          + `das die Palette selbst zeigt (${users.join(', ')}). Unter ${JND} sieht das Auge `
          + 'denselben Ton: ein Segment behauptet dann die Zugehörigkeit zum umgebenden Chrome. '
          + 'Serie verschieben, nicht die Schwelle.',
        );
      }
    }
  }
  assert.ok(checked >= 14, `Nur ${checked} Paare gemessen - erwartet werden 7 Serien x 2 Themes je Modul.`);
});

test('die Trendkurve beschriftet Skala und Zeitraum - IM Bild', () => {
  // Die Zusage ist dieselbe geblieben, ihr Ort nicht. Hier stand die Pruefung
  // auf `budget-stats__axis-max` und `__axis-x`, also auf Beschriftung
  // AUSSERHALB des SVG. Die lag dort, weil `preserveAspectRatio="none"` jeden
  // Text im Bild verzerrt haette - und genau diese Kausalitaet war verkehrt
  // herum: ohne feste Raender gibt es keinen Platz fuer eine Achse im Bild.
  // Draussen verschiebt sie sich gegen ihre eigenen Gitterlinien, sobald das
  // Diagramm skaliert (gemessen: 600x180-viewBox auf 720x216 gestreckt).
  //
  // Seit der Extraktion nach `utils/chart.js` bringt die geteilte Geometrie
  // ihren linken Gutter mit. Geprueft wird deshalb: die Achse kommt aus der
  // geteilten Quelle, und das Streckungs-Attribut ist weg.
  assert.match(stats, /chartGridMarkup\(0, max,/, 'die Werteachse kommt aus der geteilten Geometrie');
  assert.match(stats, /chartXLabelsMarkup\(/, 'die Zeitachse kommt aus der geteilten Geometrie');
  assert.doesNotMatch(stats, /preserveAspectRatio="none"/, 'eine Kurve mit Achse darf nicht gestreckt werden - der Text im Bild verzerrt mit');
  assert.doesNotMatch(stats, /budget-stats__axis-(max|mid|x)/, 'die Achse steht im SVG, nicht als HTML daneben');
});

test('die Trendkurve macht Einzelwerte ohne Zeigegerät ablesbar', () => {
  // Eine Kurve ohne Werte sagt nur "irgendwann war es viel". Der Wert muss im
  // aria-label des Punktes stehen, nicht bloß in einem Hover-Tooltip.
  assert.match(stats, /class="budget-stats__point"/);
  assert.match(stats, /aria-label="\$\{view\.ctx\.esc\(label\)\}"/);
  assert.match(stats, /statsPointLabel/);
  assert.match(stats, /role="group" aria-label="\$\{t\('budget\.statsPointsLabel'\)\}"/);
  // Ein Tabstopp für die ganze Kurve statt einem pro Tag: Roving-Tabindex.
  assert.match(stats, /tabindex="\$\{i === s\.length - 1 \? '0' : '-1'\}"/);
  const wiring = stats.match(/function wireTrendPoints[\s\S]*?\n\}/);
  assert.ok(wiring, 'wireTrendPoints fehlt');
  for (const key of ['ArrowRight', 'ArrowLeft', 'Home', 'End']) {
    assert.match(wiring[0], new RegExp(key), `Tastaturnavigation ohne ${key}`);
  }
  // Zeigen und Fokus führen beide zur selben Anzeige (Maus, Touch, Tastatur).
  assert.match(wiring[0], /addEventListener\('focusin'/);
  assert.match(wiring[0], /addEventListener\('pointerover'/);
});

test('die Datenreihen-Farben tragen ≥3:1 gegen den Seitengrund (WCAG 1.4.11)', () => {
  const hex = (value) => value.match(/[\da-f]{2}/gi).map((p) => parseInt(p, 16));
  const luminance = ([r, g, b]) => {
    const channel = (c) => { const v = c / 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
    return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
  };
  const contrast = (a, b) => {
    const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
    return (hi + 0.05) / (lo + 0.05);
  };

  // Erste Definition = Light, alle weiteren = die beiden Dark-Blöcke.
  const backgrounds = [...tokensCss.matchAll(/--_neutral-100:\s*(#[\da-fA-F]{6})/g)].map((m) => m[1]);
  assert.ok(backgrounds.length >= 2, 'Hintergrund-Token für beide Themes erwartet');

  const seriesFor = (themeIndex) => {
    const values = [];
    for (let i = 1; i <= 7; i++) {
      const all = [...tokensCss.matchAll(new RegExp(`--_chart-series-${i}:\\s*(#[\\da-fA-F]{6})`, 'g'))].map((m) => m[1]);
      assert.ok(all[themeIndex], `--_chart-series-${i} fehlt für Theme ${themeIndex}`);
      values.push(all[themeIndex]);
    }
    return values;
  };

  for (const [themeIndex, theme] of [[0, 'light'], [1, 'dark']]) {
    const bg = hex(backgrounds[themeIndex]);
    seriesFor(themeIndex).forEach((color, i) => {
      const ratio = contrast(hex(color), bg);
      assert.ok(ratio >= 3, `${theme}: --chart-series-${i + 1} (${color}) nur ${ratio.toFixed(2)}:1 gegen ${backgrounds[themeIndex]}`);
    });
  }
});

// --------------------------------------------------------
// Hard Constraints: keine Literale
// --------------------------------------------------------

test('keine hartkodierten Anzeigetexte in den Budget-Views', () => {
  assert.doesNotMatch(budget, /Loan repayment:/);
  assert.doesNotMatch(budget, /'Geschenke & Transfers'/);
  // Das Vergleichswort der Trendzeile gehört in den Locale-Key, nicht ins Template.
  assert.doesNotMatch(budget, /\}\s*vs\.\s*\$\{prevLabel\}/);
  assert.match(budget, /t\('budget\.trendDelta'/);
});

// --------------------------------------------------------
// Geteilte Bausteine des Moduls (Critique 2026-07-30, P0)
//
// Diese Guards sind bewusst als REGEL über alle Dateien des Moduls formuliert,
// nicht als Allowlist einzelner Selektoren: eine Allowlist deckt N Dateien ab,
// aber nicht die Regel - genau daran sind hier fünf Kartenbauarten und drei
// Währungsformatierer vorbeigewachsen.
// --------------------------------------------------------

// Jede Page-Datei, die unter /budget rendert. Neue Untertabs kommen hierher.
const BUDGET_PAGES = [
  ['budget.js', budget],
  ['budget-stats.js', stats],
  ['budget-plans.js', plans],
  ['subscriptions.js', subscriptions],
  ['split-expenses.js', splitExpenses],
];

// Die Stylesheets, in denen die Bauteile dieses Moduls stehen. panel.css ist
// KEIN Budget-Stylesheet, aber .metric-card und .segmented wohnen dort - waere
// es nicht in der Liste, waeren die Guards darunter genau fuer die Datei blind,
// in der der Baustein steht.
const AUDITED_STYLESHEETS = [
  ['budget.css', budgetCss],
  ['panel.css', panelCss],
  ['subscriptions.css', subscriptionsCss],
  ['split-expenses.css', splitCss],
];

// Der Schnitt stand hier als lokale Funktion und in test-frontend-audit.js als
// `.replace().replace()`-Kette OHNE Fixpunkt - zwei Fassungen desselben
// Gedankens, von denen genau eine richtig war. Er hat jetzt ein Zuhause; die
// Begruendung (warum ein einzelner Durchlauf ein `<!--` stehen laesst und
// warum die Schleife den Aufruf direkt umschliessen muss) steht dort.

// Guards, die auf Markup- oder Selektor-Muster prüfen, müssen an Kommentaren
// vorbeisehen: sonst schlägt jede Erklärung an, die das verbotene Muster nennt -
// und der Weg aus dem roten Test wäre, die Begründung zu löschen.
// Auch die Muster untereinander koennen sich gegenseitig freilegen (ein Blockkommentar
// verdeckt einen HTML-Kommentar), darum laeuft auch die Kombination bis zum Fixpunkt.
const withoutComments = (src) => {
  let out = src;
  let previous;
  do {
    previous = out;
    out = out.replace(/\/\*[\s\S]*?\*\//g, '');
    out = withoutHtmlComments(out);
    out = out.replace(/^\s*\/\/.*$/gm, '');
  } while (out !== previous);
  return out;
};

// Jede Seite, die ein Betragsfeld rendert - nicht nur das Budget-Modul. Die
// Schrittweite hängt an der Währung, und eine Währung gibt es auch ausserhalb
// von Budget (Hauspflege rechnet Tages- und Stundensätze ab).
const MONEY_INPUT_PAGES = [...BUDGET_PAGES, ['housekeeping.js', housekeeping]];

test('Betragsfelder holen ihre Schrittweite aus der Währung, nicht aus 0.01', () => {
  // Die Regel, nicht die Liste: ein Feld mit inputmode="decimal" ist entweder
  // ein Anteil in Prozent (dann trägt es max="100") oder ein Geldbetrag - und
  // dann ist eine feste Schrittweite falsch, sobald die Währung keine zwei
  // Nachkommastellen hat. Bei JPY liess step="0.01" Hundertstel Yen zu,
  // während Platzhalter und Untergrenze schon ganze Yen zeigten.
  // Eine Allowlist einzelner Feld-IDs würde nur die heute bekannten Felder
  // decken; der nächste neue Dialog fiele wieder durch.
  for (const [file, src] of MONEY_INPUT_PAGES) {
    // `[^>]` schliesst Zeilenumbrueche bereits ein (anders als `.`), eine
    // Alternative `(?:[^>]|\n)` waere also mehrdeutig - und genau das ergibt
    // exponentielles Backtracking (CodeQL js/redos).
    const inputs = withoutComments(src).match(/<input[^>]*>/g) || [];
    for (const input of inputs) {
      if (!/inputmode="decimal"/.test(input)) continue;
      if (!/step="0\.01"/.test(input)) continue;
      assert.match(
        input,
        /max="100"/,
        `${file}: Betragsfeld mit fester Schrittweite 0.01 - amountStep(currency, wert) aus utils/money.js nutzen:\n${input.replace(/\s+/g, ' ')}`,
      );
    }
  }
});

test('Geldbeträge gehen als Punkt-Dezimalstring an den Server', () => {
  // Der Server nimmt nur /^-?\d+(\.\d+)?$/ entgegen, die Eingabefelder der
  // geteilten Ausgaben sind Textfelder und folgen der Region - in de, cs oder
  // pl trennt ein Komma. Ohne Umschrift stimmt die Client-Prüfung zu und der
  // Server lehnt danach ab, mit einem Fehler, der auf kein Feld zeigt.
  const src = withoutComments(splitExpenses);
  assert.match(src, /toDecimalString[^\n]*from '\/utils\/money\.js'/, 'die Umschrift kommt aus utils/money.js');
  assert.match(src, /decimalString\s*=\s*toDecimalString/, 'die Umschrift fehlt');
  // Jeder Payload-Betrag läuft durch die Umschrift: FormData liefert den
  // Rohwert des Textfeldes, nicht den normalisierten.
  const posted = src.match(/data\.amount\s*=\s*[^\n;]+/g) || [];
  assert.ok(posted.length >= 2, 'Ausgabe und Zahlung müssen den Betrag umschreiben');
  for (const line of posted) {
    assert.match(line, /decimalString\(/, `Betrag ohne Umschrift an den Server: ${line}`);
  }

  // Die Umschrift muss die Ziffern des eingestellten Zahlensystems kennen, nicht
  // nur das ASCII-Komma: unter fa oder ar-EG zeigt der Platzhalter "۰٫۰۰" bzw.
  // "٠٫٠٠", und wer das abtippt, schickt Zeichen, die Number() nicht kennt.
  const impl = withoutComments(money).match(/export function toDecimalString[\s\S]*?\n\}/);
  assert.ok(impl, 'toDecimalString fehlt in utils/money.js');
  assert.match(impl[0], /getNumberFormat\(/, 'die Ziffern müssen aus Intl kommen, nicht aus einer Tabelle');
  // Gruppierung wird abgewiesen, nicht aufgelöst: in de-DE heisst "1.000"
  // tausend, als Dezimalzahl aber eins. Wer das still deutet, liegt bei Geld im
  // Zweifel um den Faktor tausend daneben.
  assert.doesNotMatch(impl[0], /replace\([^)]*groupSep/, 'Gruppierung darf nicht still entfernt werden');
  assert.match(impl[0], /return ''/, 'ein gruppierter Betrag muss abgewiesen werden');
});

test('jeder Speicherpfad prüft die Schrittweite selbst', () => {
  // Die Dialoge des Moduls sind keine <form>-Elemente: sie speichern über einen
  // Button-Handler, die native step-Prüfung des Browsers läuft also nie. Ein
  // angezeigtes step="1" ist damit reine Behauptung - ohne eigene Prüfung nimmt
  // das Feld trotzdem 12,5 JPY entgegen und schreibt den Wert weg, während die
  // Anzeige ihn gerundet darstellt.
  // Über alle Seiten mit Betragsfeldern, nicht nur die formularlosen: ein
  // <form> hilft hier nichts, weil amountStep bei Bestandswerten neben dem
  // Raster "any" liefert und die Browser-Prüfung damit aussetzt.
  //
  // Bewusst qualitativ und nicht als Zählung Felder-gegen-Aufrufe: eine Prüfung
  // kann mehrere Felder gemeinsam abdecken, und eine Zahlengleichheit zu
  // verlangen hiesse, den Code auf den Guard hin zu verbiegen. Er fängt damit
  // das vollständige Vergessen einer Seite, nicht das einzelne Feld - dafür
  // sind die Fall-Guards unten da.
  for (const [file, src] of MONEY_INPUT_PAGES) {
    const clean = withoutComments(src);
    if (!/step="\$\{amountStep\(/.test(clean)) continue;
    assert.match(
      clean,
      /amountIsSavable\(|rejectOffGridAmount\(/,
      `${file}: währungsgerasterte Felder, aber keine Prüfung im Speicherpfad`,
    );
  }
  assert.match(money, /export function fitsCurrencyGrid/);

  // Keine feste Toleranz gegen Float-Ungenauigkeit: 131072.02 * 100 ergibt
  // 13107201.999999998, liegt also knapp zwei Milliardstel daneben. Mit einer
  // Schranke von 1e-9 hätte jeder Speicherpfad diesen gültigen Euro-Betrag
  // abgewiesen. Der Vergleich mit der gerundeten Dezimaldarstellung braucht
  // gar keine Schranke und stimmt über jede Größenordnung.
  const clean = withoutComments(money);
  assert.doesNotMatch(clean, /1e-9/, 'Rasterprüfung darf nicht an einer festen Toleranz hängen');
  assert.doesNotMatch(clean, /Math\.round\([^)]*10 \*\* /, 'Rasterprüfung über die Dezimaldarstellung, nicht über skalierte Floats');
});

test('ein unangetasteter Bestandsbetrag bleibt speicherbar', () => {
  // Unter der alten Oberfläche mit fester Schrittweite 0,01 konnten Beträge
  // entstehen, die nicht ins Raster ihrer Währung passen. Eine unbedingte
  // Prüfung sperrte an solchen Einträgen auch das Ändern von Titel oder Notiz -
  // der Bestandswert-Schutz in amountStep wäre damit wirkungslos.
  const clean = withoutComments(budget);
  assert.match(clean, /original(?:Currency)?\s*[=:]/, 'rejectOffGridAmount kennt den Bestandswert nicht');
  // Jeder Aufruf an einem bearbeitbaren Eintrag reicht den gespeicherten Wert durch.
  //
  // DER AUSDRUCK MISST AUFRUFE, NICHT DIE DEFINITION. Frueher begann ein Treffer
  // auch an `function rejectOffGridAmount(` und lief ueber Funktionsgrenzen bis
  // zum naechsten `)) return;` - das war zufaellig ein Aufruf, dessen
  // `original:` den Treffer gruen hielt. Seit #1265 P7 steht dazwischen ein
  // `if (readOnly()) return;`, und der Treffer endete dort. `[^;]` haelt jeden
  // Treffer in EINER Anweisung; gemessen findet er auf main wie hier dieselben
  // fuenf Aufrufe, jeden einzeln statt einen davon im Bauch der Definition.
  const calls = clean.match(/(?<!function )rejectOffGridAmount\([^;]*?\)\) return;/g) || [];
  assert.ok(calls.length >= 4, `erwartet 4 Prüfungen, gefunden ${calls.length}`);
  for (const call of calls) {
    assert.match(call, /original:/, `Prüfung ohne Bestandsschutz: ${call.replace(/\s+/g, ' ').slice(0, 90)}`);
  }
});

test('jedes Formular prüft den Betrag auch selbst, nicht nur über step', () => {
  // amountStep gibt bei einem Bestandswert neben dem Raster "any" zurück, damit
  // sich der vorhandene Eintrag noch speichern lässt. Das gilt aber fürs ganze
  // Feld: wer sich allein auf die Browser-Prüfung verlässt, macht aus 12,5 JPY
  // anschliessend auch 12,555 JPY speicherbar - mehr Bruch als die feste
  // Schrittweite je zuliess. Jede Seite mit einem Betragsfeld braucht deshalb
  // eine eigene Prüfung, unabhängig davon, ob sie ein <form> ist.
  assert.match(money, /export function amountIsSavable/);
  for (const [file, src] of MONEY_INPUT_PAGES) {
    const clean = withoutComments(src);
    if (!/step="\$\{amountStep\(/.test(clean)) continue;
    assert.match(
      clean,
      /amountIsSavable\(|rejectOffGridAmount\(/,
      `${file}: währungsgerasterte Felder ohne eigene Prüfung im Speicherpfad`,
    );
  }
});

test('das inaktive Tarif-Feld ist von der Formularprüfung ausgenommen', () => {
  // Ein per `hidden` verstecktes Feld nimmt weiter an der Browser-Prüfung teil.
  // Ein liegengebliebener Tagessatz von 12,5 blockierte unter JPY damit das
  // Speichern, ohne dass etwas zu sehen war - der Knopf tat schlicht nichts.
  const clean = withoutComments(housekeeping);
  const fn = clean.match(/function updateRateFields\(\)[\s\S]*?\n  \}/);
  assert.ok(fn, 'updateRateFields nicht gefunden');
  assert.match(fn[0], /\.disabled = /, 'das inaktive Feld muss disabled werden, nicht nur versteckt');
  assert.match(clean, /\n  updateRateFields\(\);/, 'updateRateFields muss beim Öffnen einmal laufen');
});

test('nur der Trenner der Region wird zum Dezimalpunkt', () => {
  // Unter en-US gruppiert das Komma Tausender. Würde es pauschal zum Punkt,
  // machte "1,000" die Zahl 1 - ein Anteil, der um den Faktor tausend
  // danebenliegt, ohne dass irgendwo ein Fehler erscheint.
  const impl = withoutComments(money).match(/export function toDecimalString[\s\S]*?\n\}/)[0];
  assert.doesNotMatch(impl, /char === ','/, "das ASCII-Komma darf nicht pauschal als Dezimaltrenner gelten");
  assert.match(impl, /char === decimalSep/, 'der Trenner der Region fehlt');
  // Gruppierung wird abgewiesen, nicht gedeutet: "1.000" heisst in de-DE
  // tausend, als Dezimalzahl aber eins. Beide Lesarten sind vertretbar, und die
  // falsche liegt bei Geld um den Faktor tausend daneben.
  assert.match(impl, /groupSep/, 'die Gruppierung muss erkannt werden');
  assert.match(impl, /\\\\d\{3\}/, 'erkannt wird das Muster (drei Ziffern), nicht das blosse Zeichen');

  // Die Gruppierungspruefung steht ZWISCHEN den beiden Umschrift-Schritten, und
  // sie hat auf beiden Seiten eine Kante:
  //   - davor sieht `\d` (ASCII) die oestlichen Ziffern hinter dem Trenner nicht,
  //     ar-EG "٢٬٠٠٠" kaeme unerkannt durch (gemessen: als "2٬000", woraus eine
  //     Mengenangabe die 2 las);
  //   - danach ist der Dezimaltrenner schon ein Punkt, und in de-DE IST der Punkt
  //     das Gruppierungszeichen - "1,000" (also eins) floege raus.
  // Beide Faelle sind in test-shopping-ux.js verhaltensgetrieben gepinnt; hier
  // steht die Reihenfolge selbst, weil ein Textguard sie zeigt und ein
  // Verhaltenstest nur ihre Folgen.
  const ziffernSchritt = impl.search(/digits\.get\(char\)/);
  const gruppenSchritt = impl.search(/groupSep &&/);
  const trennerSchritt = impl.search(/char === decimalSep/);
  assert.ok(ziffernSchritt >= 0 && gruppenSchritt >= 0 && trennerSchritt >= 0,
    'die drei Schritte von toDecimalString sind nicht mehr erkennbar');
  assert.ok(ziffernSchritt < gruppenSchritt,
    'die Ziffern muessen VOR der Gruppierungspruefung nach ASCII - sonst sieht `\\d` sie nicht');
  assert.ok(gruppenSchritt < trennerSchritt,
    'die Gruppierung muss VOR dem Ersetzen des Dezimaltrenners geprueft werden - sonst ist der Trenner in de-DE ununterscheidbar vom Gruppierungszeichen');
});

test('keine Seite schreibt einen Dezimaltrenner von Hand um', () => {
  // Der Einkauf speichert Preise als ganze Cent (#1003) und brauchte dafuer
  // zwei Umrechnungen. Als sie in pages/shopping.js standen, war die eine ein
  // `replace(',', '.')`: unter en-US wird "1,000" damit zur Zahl 1, unter ar/fa
  // kaeme eine Eingabe in oestlichen Ziffern ueberhaupt nicht an. Die Regel
  // dafuer steht schon in toDecimalString - eine zweite Fassung daneben ist
  // genau die Dopplung, gegen die dieses Modul angelegt wurde.
  const clean = withoutComments(money);
  assert.match(clean, /export function centsToAmountInput/, 'centsToAmountInput fehlt in utils/money.js');
  assert.match(clean, /export function amountInputToCents/, 'amountInputToCents fehlt in utils/money.js');

  const rein = clean.match(/export function amountInputToCents[\s\S]*?\n\}/)[0];
  assert.match(rein, /toDecimalString\(/, 'die Eingabe muss durch toDecimalString laufen');

  // Ohne useGrouping:false schriebe das Feld "1.234,56" - und genau das weist
  // toDecimalString beim naechsten Speichern ab. Der Wert kaeme also nicht
  // wieder herein, den das Feld selbst gezeigt hat.
  const raus = clean.match(/export function centsToAmountInput[\s\S]*?\n\}/)[0];
  assert.match(raus, /useGrouping:\s*false/, 'der Ausgabewert darf nicht gruppiert sein');

  // Gemessen wird die GANZE Datei, nicht mehr nur der Preispfad. Die Einschraenkung
  // stand bis 09.09.2026 hier, weil shopping.js daneben Mengenangaben zerlegt
  // ("1,5 kg") und das kein Geldbetrag ist - aber der Trenner haengt an der Region
  // und nicht daran, wofuer die Zahl steht. Die Mengenzeile hatte denselben Fehler,
  // nur ungesehen: unter en-US wurde "1,000 g" zur Menge 1 (Faktor 1000), unter ar-EG
  // oder fa kam eine Eingabe in oestlichen Ziffern gar nicht erst an, weil `\d` ASCII
  // ist. Ein Guard, der eine bekannte Fundstelle ausnimmt, haelt genau sie offen.
  const einkauf = withoutComments(read('../public/pages/shopping.js'));
  assert.doesNotMatch(einkauf, /function (centsToInput|inputToCents)\b/,
    'shopping.js rechnet Preise wieder selbst um');
  assert.match(einkauf, /amountInputToCents\(priceRoh/,
    'der Preis muss durch amountInputToCents laufen');

  // Und die Mengenangabe laeuft positiv durch dieselbe Umschrift. Das Verhalten
  // dahinter (de "1.000 g", en-US "1,000 g", fa/ar-EG in oestlichen Ziffern) misst
  // test-shopping-ux.js an der echten Funktion - hier steht nur die Sperre gegen
  // den Rueckfall.
  const menge = einkauf.match(/function parseShoppingQuantity[\s\S]*?\n\}/);
  assert.ok(menge, 'parseShoppingQuantity nicht gefunden');
  assert.match(menge[0], /toDecimalString\(/,
    'die Mengenangabe muss durch dieselbe Umschrift laufen wie der Preis');

  // Dasselbe fuer das Skalieren einer Zutatenmenge (pages/meals.js): es LIEST eine
  // Zahl und SCHREIBT sie wieder, und beide Richtungen haengen an der Region. Die
  // Ausgabe schaute sich den Trenner vorher aus der Eingabe ab (`useComma`) - eine
  // aus Mealie gespiegelte "1.5" blieb damit auch in einer deutschen Oberflaeche
  // eine "1.5". Verhalten in test-meals.js.
  const rezept = withoutComments(read('../public/pages/meals.js'));
  const skalieren = rezept.match(/function scaleQuantityText[\s\S]*?\n\}/);
  assert.ok(skalieren, 'scaleQuantityText nicht gefunden');
  assert.match(skalieren[0], /toDecimalString\(/,
    'die gelesene Menge muss durch dieselbe Umschrift laufen');
  assert.doesNotMatch(skalieren[0], /useComma/,
    'der Trenner der Ausgabe darf nicht aus der Eingabe abgeschaut werden - getNumberFormat nutzen');
  assert.match(rezept, /function formatScaledQuantity[\s\S]*?toStoredNumber\(/,
    'die skalierte Menge muss ueber toStoredNumber geschrieben werden');

  // toStoredNumber selbst: Trenner aus der Region, Ziffern in ASCII, ohne
  // Gruppierung. Die drei haengen zusammen und stehen deshalb hier beieinander:
  //  - `getNumberFormat` liefert den Trenner der Region (sonst zeigte eine
  //    deutsche Oberflaeche "4.5");
  //  - KEIN `numberingSystem`-Zwang mehr: bis v2.65 stand hier `latn`, weil der
  //    Server nur ASCII lesen konnte und eine Menge in persischen Ziffern aus der
  //    Summierung fiel. Seit er dieselbe Umschrift benutzt (utils/digits.js), ist
  //    der Grund entfallen - und eine skalierte Zeile mischt nicht mehr zwei
  //    Schriften. Gemessen wird das in test-money-utils.js gegen den ECHTEN
  //    parseQuantity statt gegen einen Nachbau seiner Regex;
  //  - ohne `useGrouping: false` schriebe sie einen Wert, den toDecimalString
  //    beim naechsten Skalieren abweist.
  const gespeichert = clean.match(/export function toStoredNumber[\s\S]*?\n\}/);
  assert.ok(gespeichert, 'toStoredNumber fehlt in utils/money.js');
  assert.match(gespeichert[0], /getNumberFormat\(/, 'der Trenner muss aus der Region kommen');
  assert.doesNotMatch(gespeichert[0], /numberingSystem/,
    'der gespeicherte Wert folgt der Region - der Server liest sie inzwischen mit');
  assert.match(gespeichert[0], /useGrouping:\s*false/, 'der gespeicherte Wert darf nicht gruppiert sein');

  // Die Abschneide-Pruefung liegt geteilt in money.js und kennt die Trennzeichen
  // der waehlbaren Regionen. Eine Zeichenklasse „alles ausser Leerraum und
  // Ziffer" war zu breit und traf die Multiplikator-Schreibweise „2x500 g" mit.
  const abbruch = clean.match(/export function breaksOffAtSeparator[\s\S]*?\n\}/);
  assert.ok(abbruch, 'breaksOffAtSeparator fehlt in utils/money.js');
  assert.doesNotMatch(abbruch[0], /\[\^\\s\\d\]/,
    'die Trennzeichen duerfen nicht als „alles ausser Leerraum und Ziffer" geraten werden');
  assert.match(clean, /function numberSeparators[\s\S]*?REGION_CODES/,
    'die Trennzeichen muessen aus den waehlbaren Regionen abgeleitet werden');
  // `\d` waere hier ASCII - genau die Falle, gegen die diese Datei angelegt ist.
  assert.match(abbruch[0], /\\p\{Nd\}/u,
    'die Ziffernpruefung muss Unicode-Ziffern kennen, nicht nur ASCII');
  for (const [datei, quelle] of [['shopping.js', einkauf], ['meals.js', rezept]]) {
    assert.match(quelle, /breaksOffAtSeparator\(/,
      `pages/${datei} muss die geteilte Abschneide-Pruefung nutzen`);
    assert.doesNotMatch(quelle, /\[\^\\s\\d\]\\d/,
      `pages/${datei} hat wieder eine eigene, zu breite Trennerpruefung`);
  }

  // Und die Regel gilt fuer JEDE Seite, nicht fuer die drei, die bisher aufgefallen
  // sind: weder `replace(',', '.')` noch `replace(/,/g, '.')`. Genau das Auslassen
  // einer bekannten Fundstelle hat die Mengenzeile des Einkaufs offengehalten.
  const seiten = readdirSync(new URL('../public/pages/', import.meta.url)).filter((f) => f.endsWith('.js'));
  assert.ok(seiten.length > 10, `zu wenige Seiten gefunden (${seiten.length})`);
  for (const datei of seiten) {
    assert.doesNotMatch(
      withoutComments(read(`../public/pages/${datei}`)),
      /\.replace\(\s*(?:'[,.]'|"[,.]"|\/[,.]\/[a-z]*)\s*,\s*(?:'[,.]'|"[,.]")\s*\)/,
      `pages/${datei} schreibt einen Trenner von Hand um - toDecimalString aus utils/money.js nutzen`,
    );
  }
});

test('ein Abo darf null kosten', () => {
  // Gratis-Tarife sind ein gültiger Bestand: validatePayload weist erst
  // amount < 0 ab, das Schema prüft CHECK(amount >= 0). Eine Untergrenze aus
  // der kleinsten Währungseinheit sperrte das Speichern eines 0-Abos.
  const field = withoutComments(subscriptions).match(/<input[^>]*id="subscription-amount"[^>]*>/);
  assert.ok(field, 'Abo-Betragsfeld nicht gefunden');
  assert.match(field[0], /min="0"/, 'Abo-Preis braucht die Untergrenze null, nicht amountMin()');
});

test('gespeicherte Beträge werden beim Öffnen nicht gerundet', () => {
  // toFixed() auf die Nachkommastellen der Währung schrieb einen Finanzwert
  // still um: 12,50 in einem JPY-Darlehen wurde zu "13", und das nächste
  // Speichern hätte den Betrag dauerhaft auf den gerundeten Wert gesetzt.
  assert.doesNotMatch(
    withoutComments(budget),
    /\.toFixed\(currencyFractionDigits\(/,
    'budget.js: Bestandsbetrag wird beim Rendern gerundet - amountStep fängt off-grid-Werte ab',
  );
});

test('wählbare Währungen ziehen das Betragsfeld nach', () => {
  // Ein Formular, in dem die Währung gewählt werden kann, muss das Betragsfeld
  // beim Wechsel nachziehen - sonst behält es das Format der vorherigen Währung
  // und der Platzhalter widerspricht der Auswahl direkt daneben.
  assert.match(money, /export function applyAmountFormat/);
  for (const [file, src] of [['budget.js', budget], ['subscriptions.js', subscriptions], ['split-expenses.js', splitExpenses]]) {
    assert.match(
      withoutComments(src),
      /applyAmountFormat\(|amountPlaceholder\(/,
      `${file}: Währungswechsel im Formular ohne Nachziehen des Betragsfeldes`,
    );
  }
  // Beim Wechsel gilt das strikte Raster der neuen Währung. Der
  // Bestandswert-Schutz von amountStep/amountMin existiert nur fürs Öffnen des
  // Dialogs: gäbe man den aktuellen Wert auch hier weiter, liefe ein von EUR
  // auf JPY gestelltes Feld mit step="any" weiter und speicherte Hundertstel Yen.
  const body = withoutComments(money).match(/export function applyAmountFormat[\s\S]*?\n\}/)[0];
  assert.doesNotMatch(body, /amountStep\([^)]*input\.value/, 'applyAmountFormat darf den Bestandswert nicht weiterreichen');
  assert.doesNotMatch(body, /amountMin\([^)]*input\.value/, 'applyAmountFormat darf den Bestandswert nicht weiterreichen');
});

test('Geldbeträge laufen über den Modul-Formatierer, nicht über eigene', () => {
  // Drei eigene Formatierer bedeuteten vier Vorzeichenkonventionen: dieselbe
  // Zahl konnte in zwei Untertabs verschieden geschrieben sein. Bei Geld ist
  // das kein Stilproblem, sondern ein Vertrauensproblem.
  for (const [file, src] of BUDGET_PAGES) {
    assert.doesNotMatch(
      src,
      /getNumberFormat\(\{[^}]*style:\s*'currency'/,
      `${file}: Währungsformat gehört in utils/money.js, nicht in die Page`,
    );
  }
  assert.match(money, /export function formatSignedAmount/);
  assert.match(money, /export function formatMoney/);
});

test('jede Rolle des Geld-Vokabulars ist in money.js dokumentiert und behandelt', () => {
  // Das Vokabular ist der eigentliche Baustein: wer einen neuen Betrag rendert,
  // wählt eine Rolle statt eine fünfte Schreibweise zu erfinden.
  const roles = money.match(/export const MONEY_ROLES = \[([^\]]*)\]/);
  assert.ok(roles, 'MONEY_ROLES fehlt in utils/money.js');
  for (const role of ['flow', 'total', 'balance', 'plain']) {
    assert.ok(roles[1].includes(`'${role}'`), `Rolle '${role}' fehlt in MONEY_ROLES`);
    assert.ok(
      new RegExp(`\\|\\s*\`${role}\``).test(money),
      `Rolle '${role}' ist in der Rollentabelle von money.js nicht dokumentiert`,
    );
  }
  // Nur diese vier Rollen dürfen aufgerufen werden.
  for (const [file, src] of BUDGET_PAGES) {
    for (const call of src.matchAll(/formatSignedAmount\([^)]*role:\s*'([a-z]+)'/g)) {
      assert.ok(roles[1].includes(`'${call[1]}'`), `${file}: unbekannte Geld-Rolle '${call[1]}'`);
    }
    for (const call of src.matchAll(/amountByRole\([^,]+,\s*'([a-z]+)'/g)) {
      assert.ok(roles[1].includes(`'${call[1]}'`), `${file}: unbekannte Geld-Rolle '${call[1]}'`);
    }
  }
});

test('es gibt genau eine Kennzahlkarte im Modul', () => {
  // Fünf Bauarten hießen fünfmal neu lernen, wo die Zahl steht. Wer eine neue
  // Kennzahl zeigt, nimmt .metric-card - oder dieser Guard schlägt an.
  for (const [file, css] of AUDITED_STYLESHEETS) {
    for (const match of css.matchAll(/^\.([a-z-]*summary-card[a-z_-]*)/gm)) {
      assert.ok(
        match[1].startsWith('metric-card'),
        `${file}: .${match[1]} ist eine zweite Kennzahlkarte - .metric-card ist der Baustein`,
      );
    }
  }
  for (const [file, src] of BUDGET_PAGES) {
    for (const match of src.matchAll(/class="([^"]*summary-card[^"]*)"/g)) {
      assert.ok(
        /metric-card/.test(match[1]),
        `${file}: Kennzahlkarte "${match[1]}" nutzt nicht .metric-card`,
      );
    }
  }
});

test('Arbeitsflächen des Moduls sind opak, Glass bleibt den Overlays', () => {
  // budget.css begründet die Regel an .metric-card. Sie galt nur dort,
  // während subscriptions.css und split-expenses.css im selben Modul Glass auf
  // Karten, Panels und sogar auf einem Eingabefeld setzten.
  // Overlay-Rollen tragen ihr Rollenwort im Selektor; alles andere ist
  // Arbeitsfläche. Neue Arbeitsflächen fallen damit automatisch durch.
  const OVERLAY_ROLES = /modal|dialog|popover|overlay|picker-panel|form__section|tooltip|menu/;
  for (const [file, css] of AUDITED_STYLESHEETS) {
    // Regelblöcke grob zerlegen: Selektorliste bis '{', Body bis '}'.
    for (const rule of css.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
      const selector = rule[1].split('*/').pop().trim();
      if (!/--glass-bg-card|--glass-shadow/.test(rule[2])) continue;
      assert.match(
        selector,
        OVERLAY_ROLES,
        `${file}: "${selector}" ist eine Arbeitsfläche und darf kein Glass tragen`,
      );
    }
  }
});

test('kein Kontrast im Modul hängt an der Datenlage', () => {
  // Das Abo-Monogramm zog Schrift UND Fläche aus derselben Markenfarbe. Damit
  // war das Kontrastverhältnis reine Datenlage: gemessen 10 AA-Verstöße über 7
  // Marken im Seed, bis hinunter auf 1.83:1, und kein Nutzer konnte das umgehen.
  // Dieselbe Mechanik saß unbemerkt in der Konto-Kachel (--account-accent).
  //
  // REGEL: Datenfarben (die per style="--x:…" aus dem JS kommen, im Gegensatz zu
  // den Tokens aus tokens.css) dürfen in einer Fläche nicht gleichzeitig
  // Vordergrund und Hintergrund stellen. Eine von beiden Seiten muss aus einem
  // Token kommen, sonst ist das Verhältnis nicht garantierbar.
  const DATA_COLORS = new Set(
    BUDGET_PAGES.flatMap(([, src]) =>
      [...src.matchAll(/style="[^"]*?(--[a-z][a-z0-9-]*)\s*:/g)].map((m) => m[1])),
  );
  assert.ok(DATA_COLORS.size > 0, 'keine Datenfarben gefunden - der Guard misst nichts');

  const varsIn = (decls) => [...decls.matchAll(/var\(\s*(--[a-z0-9-]+)/gi)].map((m) => m[1]);
  for (const [file, css] of AUDITED_STYLESHEETS) {
    for (const rule of css.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
      const body = rule[2];
      const fg = [...body.matchAll(/(?:^|;)\s*color\s*:([^;]*)/g)].map((m) => m[1]).join(' ');
      const bg = [...body.matchAll(/(?:^|;)\s*background(?:-color)?\s*:([^;]*)/g)].map((m) => m[1]).join(' ');
      if (!fg.trim() || !bg.trim()) continue;
      const shared = varsIn(fg).filter((v) => DATA_COLORS.has(v) && varsIn(bg).includes(v));
      assert.equal(
        shared.length, 0,
        `${file}: "${rule[1].split('*/').pop().trim()}" zieht ${shared.join(', ')} `
        + 'für Schrift UND Fläche - der Kontrast hängt damit an den Nutzerdaten',
      );
    }
  }
});

test('eingebettete Untertabs bringen kein eigenes Seiten-Chrome mit', () => {
  // Ein eigener Seiten-Gradient im Sub-Page-Wrapper lief als getönte
  // Vollbreiten-Bahn innerhalb der Budget-Seite und brach an deren Container-
  // Kante ab. Fläche und Rand gehören dem Panel.
  for (const [file, css, selector] of [
    ['subscriptions.css', subscriptionsCss, '.budget-page .subscriptions-page'],
    ['split-expenses.css', splitCss, '.budget-page .split-page'],
  ]) {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const rule = css.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`));
    assert.ok(rule, `${file}: ${selector}-Override fehlt`);
    assert.match(rule[1], /background:\s*none/, `${file}: ${selector} muss den eigenen Gradient ablegen`);
    assert.match(rule[1], /padding-block:\s*0/, `${file}: ${selector} muss den eigenen Rand ablegen`);
  }
});

test('Panel-Fläche und Kopfleiste sind geteilt, nicht pro Tab gebaut', () => {
  // Drei Padding-Werte und drei Scroll-Achsen über sieben Tabs waren drei
  // Gelegenheiten, die Fläche unterschiedlich zu bauen.
  const panel = budgetCss.match(/\n\.budget-tab-panel\s*\{([^}]*)\}/);
  assert.ok(panel, '.budget-tab-panel fehlt in budget.css');
  assert.match(panel[1], /overflow-y:\s*auto/);
  assert.match(panel[1], /padding-block-start:\s*var\(--space/);

  assert.ok(/\n\.panel-head\s*\{/.test(panelCss), '.panel-head fehlt in panel.css');
  assert.ok(/\n\.panel-head__title\s*\{/.test(panelCss), '.panel-head__title fehlt');

  // Kein Tab setzt Scroll-Achse oder Panel-Padding noch selbst. Ausnahmen sind
  // benannte Modifier (--budget hält seine eigene innere Scroll-Region).
  const ALLOWED_PANEL_OVERRIDES = /budget-tab-panel--budget/;
  for (const rule of budgetCss.matchAll(/(\.budget-tab-panel--[a-z-]+)(?:[^{}]*)\{([^}]*)\}/g)) {
    if (!/overflow-y|padding-block-start|padding-top/.test(rule[2])) continue;
    assert.match(
      rule[1],
      ALLOWED_PANEL_OVERRIDES,
      `${rule[1]} setzt Scroll-Achse oder Padding selbst - beides gehört .budget-tab-panel`,
    );
  }
});

test('die Übersicht hat EINEN Scrollport, und die Liste ist keiner (#904, Critique 2026-09-25)', () => {
  // Zwei Fassungen desselben Defekts. #904: das Panel clippte, und die
  // Listensektion kollabierte neben dem inhaltshohen Kategorie-Chart - die
  // Liste war auf kurzen Viewports unerreichbar. Die Antwort damals war eine
  // 280px-Untergrenze für einen INNEREN Listen-Scroller; gemessen bei
  // 1440x900 wurde daraus ein Guckloch von 220px für 1494px Buchungen, 3
  // Zeilen sichtbar, und zwei Scroller ineinander (Panel + Liste). Jetzt
  // scrollt nur das Panel, und die Liste wächst mit ihrem Inhalt - damit ist
  // sie auf jedem Viewport erreichbar, ohne Untergrenze.
  //
  // Geprüft wird jede Regel, deren SUBJEKT (letzter Compound) das Element
  // trifft, in JEDEM At-Block - eine Container- oder Höhen-Query wäre der
  // wahrscheinlichste Rückweg für den inneren Scroller.
  const subjectIs = (selector, cls) => selector.split(',').some((einzel) => {
    const compounds = einzel.trim().split(/[\s>+~]+/).filter(Boolean);
    return compounds.length > 0 && new RegExp(`${cls.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&')}(?![\\w-])`).test(compounds[compounds.length - 1]);
  });
  const overflowDecls = (body) => [...body.matchAll(/(?:^|;)\s*(overflow(?:-y|-block)?)\s*:\s*([^;]+)/g)];

  let panelSeen = false;
  let listSeen = false;
  for (const { selector, body, at } of eachRule(budgetCss)) {
    if (subjectIs(selector, '.budget-tab-panel--budget')) {
      panelSeen = true;
      for (const [, prop, value] of overflowDecls(body)) {
        assert.ok(
          !/\b(?:hidden|clip)\b/.test(value),
          `"${selector.trim()}" clippt das Budget-Panel (${prop}: ${value.trim()}) - es ist `
          + 'der EINE Scrollport der Übersicht, seine Scroll-Achse muss offen bleiben (#904)',
        );
      }
    }
    for (const cls of ['.budget-list', '.budget-list-section']) {
      if (!subjectIs(selector, cls)) continue;
      if (cls === '.budget-list') listSeen = true;
      const where = at.length ? ` in ${at.join(' / ')}` : '';
      for (const [, prop, value] of overflowDecls(body)) {
        assert.ok(
          !/\b(?:auto|scroll)\b/.test(value),
          `"${selector.trim()}"${where} macht die Liste wieder zum Scroller (${prop}: ${value.trim()}) - `
          + 'das war das 220px-Guckloch neben einem zweiten Scroller (Critique 2026-09-25)',
        );
      }
      assert.doesNotMatch(
        body,
        /(?:^|;)\s*(?:min-height|max-height|height|flex)\s*:/,
        `"${selector.trim()}"${where} gibt der Liste eine feste Höhe oder ein Scrollfenster - `
        + 'sie wächst mit ihrem Inhalt, das Panel scrollt',
      );
    }
  }
  assert.ok(panelSeen, '.budget-tab-panel--budget fehlt in budget.css');
  assert.ok(listSeen, '.budget-list fehlt in budget.css');
  // Die Rolle „ich bin der Scrollport meiner Seite" trägt nur noch das Panel -
  // eine Liste mit der Rolle bekäme den Nachlauf, obwohl sie nicht scrollt.
  assert.doesNotMatch(budget, /class="budget-list page-scrollport"/);
  assert.match(budget, /class="budget-list" id="budget-list"/);
});

test('die Übersicht wird ab 960px Container zweispaltig: Buchungen links, Bilanz sticky rechts', () => {
  // Vorher lag rechts der 720px-Bahn 436px (1440) bzw. 276px (1280) leere
  // Fläche, während die Liste im Guckloch scrollte. Container- statt Viewport-
  // Query: die Sidebar zieht ~220px ab.
  const grid = [...eachRule(budgetCss)].find(({ selector, body, at }) => selector.trim() === '.budget-overview'
    && /display:\s*grid/.test(body)
    && at.some((a) => /@container\s+budget-page\s*\(\s*min-width:\s*\d+px\s*\)/.test(a)));
  assert.ok(grid, '.budget-overview wird unter @container budget-page (min-width) nicht zum Raster');
  assert.match(grid.body, /grid-template-columns:[^;]*var\(--page-measure[^;]*var\(--budget-rail-max\)/,
    'links das Lesemass, rechts die Seitenleiste bis --budget-rail-max');
  const width = Number(grid.at.join(' ').match(/min-width:\s*(\d+)px/)[1]);
  assert.ok(width >= 900 && width <= 1100, `Schwelle ${width}px: neben ~640px Liste muss die Seitenleiste Platz haben`);

  // Sticky NUR über die Klasse, die budget.js setzt, solange die Leiste in den
  // Scrollport passt - eine höhere angeheftete Leiste zeigte ihr Ende erst am
  // Listenende.
  for (const { selector, body } of eachRule(budgetCss)) {
    if (!/position:\s*sticky/.test(body) || !/budget-overview__aside/.test(selector)) continue;
    assert.match(selector, /budget-overview__aside--pinned/, `"${selector.trim()}" heftet die Leiste ohne Passprüfung an`);
  }
  assert.ok([...eachRule(budgetCss)].some(({ selector, body }) => /\.budget-overview__aside--pinned/.test(selector) && /position:\s*sticky/.test(body)),
    'die angeheftete Seitenleiste ist nicht sticky');
  const fit = budget.match(/function watchAsideFit\(panel\) \{[\s\S]*?\n\}/);
  assert.ok(fit, 'watchAsideFit fehlt');
  assert.match(fit[0], /new ResizeObserver/);
  assert.match(fit[0], /classList\.toggle\('budget-overview__aside--pinned', aside\.offsetHeight <= panel\.clientHeight\)/);
  assert.match(fit[0], /_asideFit\?\.disconnect\(\)/, 'der alte Beobachter wird beim Neuzeichnen nicht getrennt');
  assert.match(budget, /watchAsideFit\(body\.querySelector\('\.budget-tab-panel--budget'\)\)/);

  // Die Seitenleiste steht im Markup VOR der Liste: einspaltig bleibt die Lese-
  // und Tab-Reihenfolge Bilanz -> Kategorien -> Buchungen.
  const aside = budget.indexOf('<div class="budget-overview__aside">');
  const list = budget.indexOf('<div class="budget-list-section">');
  assert.ok(aside > 0 && list > aside, 'Seitenleiste muss im Markup vor der Liste stehen');
});

test('alle Tabs teilen EINE Bahn: gleiche linke Kante, gleiches Mass, der Plan nicht zentriert', () => {
  // Drei Bahnen vorher: Übersicht 720 links, Plan 640 ZENTRIERT, Rest 1156.
  const lane = [...eachRule(budgetCss)].find(({ selector, at }) => selector.trim() === '.budget-tab-panel > *' && at.length === 0);
  assert.ok(lane, '.budget-tab-panel > * setzt kein gemeinsames Mass');
  assert.match(lane.body, /max-width:\s*var\(--budget-lane\)/);
  assert.match(budgetCss, /--budget-lane:\s*calc\(var\(--page-measure[^;]*var\(--budget-rail-max\)\)/,
    'die Bahn ist Lesemass + Abstand + Seitenleiste - genau die Breite der Zweispalte');
  for (const { selector, body } of eachRule(budgetCss)) {
    if (!/budget-tab-panel/.test(selector)) continue;
    assert.doesNotMatch(body, /margin-inline:\s*auto|margin:\s*[^;]*\bauto\b/,
      `"${selector.trim()}" zentriert ein Panel - jeder Tab beginnt an der Kante von Kopf und Tabs`);
    if (/^\.budget-tab-panel(?:--[\w-]+)?$/.test(selector.trim())) {
      assert.doesNotMatch(body, /max-width/,
        `"${selector.trim()}" kappt den Scrollport selbst - das Mass gehört an seine Kinder`);
    }
  }
});

test('„Nur Ausgaben" steht in der Kopfzeile der Bilanz und trifft voll', () => {
  // Vorher eigene 40px-Zeile rechtsbündig über der Seite, 312px neben der Bahn,
  // Treffhöhe 28px.
  const head = budget.match(/<div class="budget-summary-head">[\s\S]*?<\/div>/);
  assert.ok(head, '.budget-summary-head fehlt');
  // Der Titel nennt einen Zukunftsmonat eine Prognose (Critique 2026-09-25) -
  // es bleibt EIN h2 an derselben Stelle.
  assert.match(head[0], /<h2 class="u-section-title" id="budget-summary-title">\$\{t\(forecast \? 'budget\.summaryTitleForecast' : 'budget\.summaryTitle'\)\}<\/h2>/);
  assert.match(head[0], /id="budget-expenses-only"/);
  assert.doesNotMatch(budget, /budget-summary-bar/);
  assert.doesNotMatch(budgetCss, /\.budget-summary-bar\b/);
  const hit = [...eachRule(budgetCss)].find(({ selector }) => selector.trim() === '.budget-expenses-toggle::before');
  assert.ok(hit, 'die Pille dehnt ihre Treffflaeche nicht aus');
  assert.match(hit.body, /height:\s*var\(--target-base\)/);
  const row = [...eachRule(budgetCss)].find(({ selector }) => selector.trim() === '.budget-summary-head');
  assert.match(row.body, /min-height:\s*var\(--target-base\)/, 'die Kopfzeile muss die Treffflaeche fassen');
  assert.match(row.body, /max-width:\s*var\(--page-measure/, 'der Umschalter endet an der Bahn');
});

test('Abschnittstitel aller Budget-Panels sind h2 in EINEM Stil', () => {
  // Vorher: „Nach Kategorie" 20px/600, daneben 12px-Versal als EINZIGER Titel
  // (Konten, Darlehen), der Plan sprang von h1 auf ein 16px-h3.
  for (const [file, src, cls] of [
    ['budget.js', budget, 'budget-chart-section__title'],
    ['budget.js', budget, 'budget-list-header__title'],
    ['budget.js', budget, 'panel-head__title'],
    ['budget-stats.js', stats, 'budget-chart-section__title'],
    ['budget-plans.js', plans, 'budget-plan__section-title'],
  ]) {
    const tags = [...src.matchAll(new RegExp(`<(\\w+)\\b[^>]*class="[^"]*\\b${cls}\\b`, 'g'))].map((m) => m[1]);
    assert.ok(tags.length > 0, `${file}: .${cls} nicht gefunden`);
    for (const tag of tags) assert.equal(tag, 'h2', `${file}: .${cls} ist ein <${tag}>, kein <h2>`);
  }
  assert.doesNotMatch(plans, /<h3\b/, 'budget-plans.js: <h3> direkt unter dem <h1> der Seite');
  const typography = read('../public/styles/typography.css');
  const blockOf = (sel) => [...eachRule(typography)].find(({ selector }) => selector.split(',').map((x) => x.trim()).includes(sel));
  const section = blockOf('.u-section-title');
  assert.ok(section.selector.split(',').map((x) => x.trim()).includes('.panel-head__title'),
    '.panel-head__title gehört zur Bereichs-Überschrift, nicht zum Versal-Label');
  const eyebrow = blockOf('.metric-card__label');
  assert.ok(!eyebrow.selector.split(',').map((x) => x.trim()).includes('.panel-head__title'),
    '.panel-head__title steht noch im Versal-Block');
});

test('Trendpfeile sind Icons, keine Textglyphen', () => {
  // Die Pfeil-Entscheidung wohnt seit Block 2 in der geteilten Trend-API
  // (utils/metric-card.js) - budget.js formatiert nur noch den Text.
  const metricCard = read('../public/utils/metric-card.js');
  assert.doesNotMatch(budget, /'▲'/);
  assert.doesNotMatch(budget, /'▼'/);
  assert.doesNotMatch(metricCard, /'▲'/);
  assert.doesNotMatch(metricCard, /'▼'/);
  assert.match(metricCard, /trending-up/);
  assert.match(metricCard, /trending-down/);
  assert.match(budget, /trendMarkup\(/);
});

test('Konto-Farben kommen aus Tokens und tragen sprechende Labels', () => {
  const palette = budget.match(/const ACCOUNT_COLORS = \[[\s\S]*?\];/);
  assert.ok(palette, 'ACCOUNT_COLORS fehlt');
  assert.doesNotMatch(palette[0], /#[0-9a-fA-F]{6}/, 'Hex-Literale gehören in tokens.css');
  assert.match(palette[0], /nameKey: 'budget\.color/);
  // Screenreader lasen vorher den Hexcode vor.
  assert.match(budget, /t\(c\.nameKey\)/);
});

test('kein toter Toast-Typ: nur gestylte Varianten werden verwendet', () => {
  const styled = new Set(['success', 'danger', 'warning', 'default']);
  for (const [file, src] of [['budget.js', budget], ['budget-stats.js', stats], ['budget-plans.js', plans], ['subscriptions.js', subscriptions]]) {
    for (const match of src.matchAll(/showToast\([^)]*?,\s*'([a-z]+)'/g)) {
      assert.ok(styled.has(match[1]), `${file}: showToast-Typ '${match[1]}' hat keine Styles`);
    }
  }
});

// --------------------------------------------------------
// Saldo entdramatisieren bei reinem Ausgaben-Tracking (#504)
// --------------------------------------------------------

test('Saldo wird neutral, wenn keine Einnahmen erfasst sind', () => {
  // Ohne Einnahmen ist balance = -Ausgaben eine Tautologie; die rote Zahl liest
  // sich fälschlich als „im Minus". Bedingung: income === 0 && balance < 0.
  assert.match(budget, /const balanceNeutral = s\.income === 0 && s\.balance < 0;/);
  assert.match(budget, /balanceNeutral[\s\S]{0,80}metric-card--balance-neutral/);
  // Echte Einnahmen behalten die Farbsemantik (grün Überschuss / rot Mehrausgabe).
  assert.match(budget, /metric-card--balance-positive/);
  assert.match(budget, /metric-card--balance-negative/);
});

test('der Saldo-Trend entfällt im neutralen Ausgaben-Fall', () => {
  // Ein farbiger Trendpfeil unter der bewusst neutralisierten Zahl wäre widersprüchlich
  // und ohne echten Saldo ohne Aussage.
  assert.match(budget, /p && !balanceNeutral \? renderTrend\(s\.balance/);
});

test('die neutrale Saldo-Farbe kommt aus einem Token, nicht als Literal', () => {
  const rule = panelCss.match(/\.metric-card--balance-neutral[^\n]*\{[^}]*\}/);
  assert.ok(rule, '.metric-card--balance-neutral fehlt in panel.css');
  assert.match(rule[0], /var\(--color-text-primary\)/);
  assert.doesNotMatch(rule[0], /var\(--color-danger\)|var\(--color-success\)/);
});

// --------------------------------------------------------
// „Nur Ausgaben"-Umschalter (#504)
// --------------------------------------------------------

test('„Nur Ausgaben" reduziert die Zusammenfassung auf die Ausgaben-Karte', () => {
  // Reines Ausgaben-Tracking soll weder einen (neutralen) Saldo noch eine Dauer-Null
  // bei den Einnahmen zeigen - der Umschalter blendet beide Karten aus.
  assert.match(budget, /expensesOnly \? expensesCard : incomeCard \+ expensesCard \+ balanceCard/);
});

test('der „Nur Ausgaben"-Umschalter meldet seinen Zustand als echter Switch', () => {
  assert.match(budget, /id="budget-expenses-only"[\s\S]{0,120}role="switch"/);
  assert.match(budget, /aria-checked="\$\{expensesOnly \? 'true' : 'false'\}"/);
});

test('der „Nur Ausgaben"-Zustand ist client-persistent und geräte-lokal', () => {
  // Reine Anzeige-Präferenz über localStorage (yuvomi-*), kein Server-Roundtrip -
  // Liste, Diagramm und CSV-Export bleiben unberührt.
  assert.match(budget, /const EXPENSES_ONLY_KEY = 'yuvomi-budget-expenses-only';/);
  assert.match(budget, /state\.expensesOnly = localStorage\.getItem\(EXPENSES_ONLY_KEY\) === '1';/);
  assert.match(budget, /localStorage\.setItem\(EXPENSES_ONLY_KEY, state\.expensesOnly \? '1' : '0'\)/);
});

test('die Ausgaben-Karte trägt im „Nur Ausgaben"-Modus die volle Breite', () => {
  // Die Spaltenzahl der geteilten Kennzahl-Zeile kommt seit der Baustein-
  // Extraktion aus --summary-cards; geprüft wird die Invariante (eine Spalte),
  // nicht mehr die grid-template-columns-Schreibweise.
  const rule = panelCss.match(/\.metric-grid--expenses-only[^\n]*\{[^}]*\}/);
  assert.ok(rule, '.metric-grid--expenses-only fehlt in panel.css');
  assert.match(rule[0], /--summary-cards:\s*1/);

  const base = panelCss.match(/\n\.metric-grid\s*\{[^}]*\}/);
  assert.ok(base, '.metric-grid fehlt in panel.css');
  assert.match(base[0], /grid-template-columns:\s*repeat\(var\(--summary-cards[^)]*\)/);
});

test('der „Nur Ausgaben"-Umschalter nutzt Tokens, keine Farbliterale', () => {
  const rule = budgetCss.match(/\.budget-expenses-toggle\s*\{[^}]*\}/);
  assert.ok(rule, '.budget-expenses-toggle fehlt in budget.css');
  assert.doesNotMatch(rule[0], /#[0-9a-fA-F]{3,8}\b/);
});

// --------------------------------------------------------
// Zustand, Fokus, Ladewahrnehmung
// --------------------------------------------------------

test('Filterzustand überlebt den Modulwechsel nicht', () => {
  // `state` ist ein Modul-Singleton: ohne Reset zeigt das Budget beim nächsten
  // Besuch noch den Kontoauszug von damals.
  const enter = budget.match(/export async function render\([\s\S]*?renderBody\(\);/);
  assert.ok(enter);
  for (const field of ['accountFilterId', 'loanFilterId', 'loanStatusFilter', 'accountsShowArchived']) {
    assert.match(enter[0], new RegExp(`state\\.${field} = `), `${field} wird beim Betreten nicht zurückgesetzt`);
  }
});

test('der Konto-Drilldown verliert den Fokus nicht', () => {
  assert.match(budget, /_container\.querySelector\('#budget-body'\)\?\.focus\(\)/);
});

test('das Inline-Kategorie-Overlay ist ein vollwertiger Dialog', () => {
  const overlay = budget.match(/function requestNameInPanel[\s\S]*?\n\}/);
  assert.ok(overlay);
  assert.match(overlay[0], /e\.key === 'Escape'/);
  assert.match(overlay[0], /e\.key !== 'Tab'/, 'Fokus-Trap fehlt');
  assert.match(overlay[0], /opener\?\.isConnected/, 'Fokus kehrt nicht zum Auslöser zurück');
});

test('Berichte und Plan zeigen beim Laden ein Skelett', () => {
  assert.match(stats, /renderSkeletonList/);
  assert.match(plans, /renderSkeletonList/);
});

// --------------------------------------------------------
// Abo-Filterleiste
// --------------------------------------------------------

test('Abo-Filter tragen sichtbare Labels und lassen sich zurücksetzen', () => {
  for (const key of ['filterLabelCategory', 'filterLabelMethod', 'filterLabelStatus', 'filterLabelSort']) {
    assert.match(subscriptions, new RegExp(`subscriptions\\.${key}`), `sichtbares Label ${key} fehlt`);
  }
  assert.match(subscriptions, /function hasActiveFilters/);
  assert.match(subscriptions, /async function resetFilters/);
  // Leere Liste durch Filter ist ein anderer Zustand als "noch keine Abos".
  assert.match(subscriptions, /subscriptions\.noMatchesTitle/);
});

// --------------------------------------------------------
// i18n
// --------------------------------------------------------

test('alle neuen Keys existieren in jeder Locale', () => {
  const keys = [
    'budget.trendDelta', 'budget.statsRangeLabel', 'budget.statsOtherCategories',
    'budget.statsTrendSummary', 'budget.statsDonutSummary',
    'budget.colorTeal', 'budget.colorBlue', 'budget.colorViolet', 'budget.colorMagenta',
    'budget.colorOrange', 'budget.colorGreen', 'budget.colorOcher',
    'budget.statsPointLabel', 'budget.statsPointsLabel',
    'budget.expensesOnly', 'budget.expensesOnlyHint',
    'subscriptions.resetFilters', 'subscriptions.noMatchesTitle', 'subscriptions.noMatchesDescription',
    'subscriptions.filterLabelCategory', 'subscriptions.filterLabelMethod',
    'subscriptions.filterLabelStatus', 'subscriptions.filterLabelSort',
  ];
  const files = readdirSync(new URL('../public/locales/', import.meta.url)).filter((f) => f.endsWith('.json'));
  assert.ok(files.length >= 23, 'unerwartet wenige Locale-Dateien');
  for (const file of files) {
    const data = JSON.parse(read(`../public/locales/${file}`));
    for (const key of keys) {
      const value = key.split('.').reduce((v, part) => (v != null ? v[part] : undefined), data);
      assert.equal(typeof value, 'string', `${file}: ${key} fehlt`);
      assert.ok(value.trim().length > 0, `${file}: ${key} ist leer`);
    }
  }
});

test('die Platzhalter der neuen Sätze bleiben in jeder Locale erhalten', () => {
  const expected = {
    'budget.trendDelta': ['{{amount}}', '{{month}}'],
    'budget.statsTrendSummary': ['{{periods}}', '{{income}}', '{{expenses}}', '{{peak}}'],
    'budget.statsDonutSummary': ['{{count}}', '{{top}}', '{{pct}}', '{{total}}'],
    'budget.statsPointLabel': ['{{period}}', '{{income}}', '{{expenses}}'],
  };
  const files = readdirSync(new URL('../public/locales/', import.meta.url)).filter((f) => f.endsWith('.json'));
  for (const file of files) {
    const data = JSON.parse(read(`../public/locales/${file}`));
    for (const [key, placeholders] of Object.entries(expected)) {
      const value = key.split('.').reduce((v, part) => v[part], data);
      for (const placeholder of placeholders) {
        assert.ok(value.includes(placeholder), `${file}: ${key} ohne ${placeholder}`);
      }
    }
  }
});

// --------------------------------------------------------
// Wiederholung: Einheit + Anzahl (#636)
// --------------------------------------------------------

test('das Intervall-Feld bietet Einheit und Anzahl, ohne half_year', () => {
  const start = budget.indexOf('id="bm-recurrence-options"');
  const modal = budget.slice(start, budget.indexOf('renderDocumentAttachField', start));
  for (const key of ['budget.intervalWeekly', 'budget.intervalMonthly', 'budget.intervalYearly']) {
    assert.ok(modal.includes(key), `${key} fehlt im Intervall-Feld`);
  }
  assert.ok(!budget.includes('intervalHalfYear'), 'half_year ist als Rhythmus abgelöst (monatlich x 6)');
  assert.ok(!budget.includes("'half_year'"), 'kein half_year-Literal mehr im Frontend');
  assert.match(modal, /id="bm-interval-count"[\s\S]*?min="1"[\s\S]*?max="99"/, 'Anzahl-Feld mit Grenzen 1..99');
  assert.ok(modal.includes('id="bm-interval-unit"'), 'Einheitenwort neben der Zahl');
});

test('das Einheitenwort kommt aus der geteilten Quelle, nicht aus einer zweiten Zuordnung', () => {
  // Die Zuordnung Einheit -> Wort lebt in rrule-ui.js. Eine eigene Liste im
  // Budget-Modal wäre beim nächsten Sprachwechsel die Stelle, die zurückbleibt.
  assert.match(budget, /import \{ intervalUnitLabel \} from '\/rrule-ui\.js'/);
  assert.ok(budget.includes('intervalUnitLabel('), 'Label über die geteilte Funktion');
  for (const key of ['rrule.unitWeek', 'rrule.unitMonths', 'rrule.unitYears']) {
    assert.ok(!budget.includes(key), `${key} gehört nicht ins Budget-Modal`);
  }
});

test('die Anzahl reist mit dem Eintrag zum Server', () => {
  assert.ok(budget.includes('recurrence_interval_count: intervalN'), 'Anzahl fehlt im Request-Body');
  assert.match(budget, /Math\.min\(99, Math\.max\(1,[^)]*bm-interval-count/, 'Anzahl wird vor dem Senden geklemmt');
});

// --------------------------------------------------------
// Bestätigung vor der Buchung (#637)
// --------------------------------------------------------

test('eine erwartete Buchung ist in der Liste als solche erkennbar und buchbar', () => {
  assert.ok(budget.includes('budget-badge--pending'), 'Marke an der Zeile fehlt');
  assert.ok(budget.includes('budget.pendingBadge'), 'Beschriftung der Marke fehlt');
  assert.match(budget, /data-action="confirm"/, 'Buchen-Aktion fehlt an der Zeile');
  assert.ok(budget.includes('budget-entry--pending'), 'Zeile trägt keinen eigenen Zustand');
  assert.ok(budgetCss.includes('.budget-badge--pending'), 'Marke ohne Stil');
  assert.ok(budgetCss.includes('.budget-entry--pending'), 'Zeilenzustand ohne Stil');
});

test('der Bestätigen-Dialog lässt Betrag und Datum korrigieren', () => {
  const modal = budget.slice(budget.indexOf('async function openConfirmBookingModal'));
  assert.ok(modal.includes('cb-amount'), 'Betragsfeld fehlt');
  assert.ok(modal.includes('cb-date'), 'Datumsfeld fehlt');
  assert.ok(modal.includes('yuvomi-datepicker'), 'Datum über die geteilte Komponente');
  assert.match(modal, /api\.patch\(`\/budget\/\$\{id\}\/confirm`/, 'ruft die Bestätigungs-Route nicht auf');
  assert.ok(modal.includes('rejectOffGridAmount'), 'Betrag ohne Währungsraster-Prüfung');
});

test('was noch aussteht, steht unter den Summenkarten', () => {
  // Sonst verschwände das Geld: die Buchung ist in der Liste, aber in keiner
  // Karte, und niemand könnte sagen, um wie viel die Übersicht danebenliegt.
  assert.ok(budget.includes('budget.pendingSummary'), 'Hinweiszeile fehlt');
  assert.ok(budget.includes('budget-pending-note'), 'Hinweiszeile ohne eigene Klasse');
  assert.ok(budgetCss.includes('.budget-pending-note'), 'Hinweiszeile ohne Stil');
});

test('die Bestätigungspflicht ist eine Eigenschaft der Serie', () => {
  const modal = budget.slice(budget.indexOf('id="bm-recurrence-options"'), budget.indexOf('renderDocumentAttachField', budget.indexOf('id="bm-recurrence-options"')));
  assert.ok(modal.includes('bm-confirm-first'), 'Schalter fehlt im Wiederholungs-Block');
  assert.ok(modal.includes('budget.confirmFirstLabel'), 'Beschriftung fehlt');
  assert.ok(budget.includes('recurrence_confirm: confirmFirst'), 'Feld reist nicht zum Server');
});

// --------------------------------------------------------
// Rate eines Darlehens im Eintrags-Dialog (#638/#859)
// --------------------------------------------------------

test('der Typ-Umschalter nimmt bei einer Darlehensrate keine Eingabe entgegen', () => {
  // Ob eine Rate Einnahme oder Ausgabe ist, entscheidet die Richtung des Darlehens.
  // Der Server bucht danach und würde eine hier gewählte Umkehr still zurückdrehen -
  // ein Umschalter, der scheinbar etwas ändert und dann überstimmt wird, ist die
  // schlechtere Hälfte von beidem.
  const toggle = budget.slice(budget.indexOf('class="amount-type-toggle'), budget.indexOf('id="bm-title"'));
  const buttons = [...toggle.matchAll(/id="type-(expense|income)"[^>]*/g)].map((m) => m[0]);
  assert.equal(buttons.length, 2, 'die beiden Typ-Schalter sind nicht mehr auffindbar');
  for (const btn of buttons) {
    assert.match(btn, /isLoanPayment \? 'disabled' : ''/,
      `${btn.slice(0, 24)} ist bei einer Darlehensrate weiter bedienbar`);
  }
  assert.ok(toggle.includes('budget.loanPaymentTypeLocked'), 'die Sperre bleibt unerklärt');
});

test('das Bearbeiten-Modal bekommt immer einen echten Eintrag, nie einen nachgebauten', () => {
  // loanPaymentToEntry() baut aus einer Rate ein Anzeige-Objekt: Betrag in
  // Darlehenswährung, ohne Konto, ohne Sichtbarkeit, ohne Belege. Als Vorlage zum
  // Bearbeiten schriebe es den Ratenbetrag als Budget-Betrag zurück (bei
  // Fremdwährung um den Kurs daneben) und leerte jedes Feld, das es nicht kennt.
  // Es ist deshalb kein Einstieg ins Modal - der Drilldown liefert den echten.
  const built = budget.slice(budget.indexOf('function loanPaymentToEntry'), budget.indexOf('function renderLoanPaymentEntry'));
  assert.doesNotMatch(built, /openBudgetModal/, 'der Nachbau oeffnet selbst das Modal');

  const handler = budget.slice(budget.indexOf("data-action=\"loan-payment-edit\"]').forEach"));
  const body = handler.slice(0, handler.indexOf('});'));
  assert.doesNotMatch(body, /loanPaymentToEntry/,
    'der Bearbeiten-Knopf oeffnet das Modal mit dem nachgebauten Objekt');
  assert.match(body, /openLoanPaymentEntry/, 'der Bearbeiten-Knopf laedt den Eintrag nicht nach');

  const loader = budget.slice(budget.indexOf('async function openLoanPaymentEntry'));
  const loaderBody = loader.slice(0, loader.indexOf('\nfunction '));
  assert.match(loaderBody, /api\.get\(`\/budget\?loan_id=/, 'der Eintrag kommt nicht aus dem Drilldown');
  assert.match(loaderBody, /loan_payment_id === paymentId/, 'die geladene Zeile wird nicht der Rate zugeordnet');
  assert.match(loaderBody, /openBudgetModal\(\{ mode: 'edit', entry \}\)/, 'das Modal wird nicht mit dem geladenen Eintrag geoeffnet');
});

/**
 * Ein leeres Konto-Feld an einer kontolosen Instanz nimmt der Serie nicht ihr
 * Konto (#973).
 *
 * Das Feld zeigt das Konto DIESER Buchung, der Serien-Dialog gilt aber der
 * ganzen Serie. Genau die Instanzen, denen #973 das Konto vorenthalten hat,
 * hätten es beim Bearbeiten mit `account_id: null` an die Serie weitergereicht
 * und deren Konto gelöscht - reproduziert, bevor die Zeile entstand.
 *
 * EHRLICH ZUM GELTUNGSBEREICH: das hier misst die Schreibweise, nicht die
 * Sache. `public/pages/budget.js` hat keine `__test`-Naht, der Sendepfad ist
 * also aus einer Suite nicht aufrufbar. Der Guard hält damit den Fall fest, dass
 * jemand die Zeile entfernt - nicht den, dass jemand sie unwirksam macht. Die
 * Naht ist die richtige Folgearbeit; sie gehört nicht in einen Bugfix.
 */
test('Serien-Speichern reicht ein leeres Konto einer kontolosen Instanz nicht weiter (#973)', () => {
  const start = budget.indexOf("if (scope === 'series')");
  assert.ok(start >= 0, 'der Serien-Zweig muss auffindbar sein');
  const zweig = budget.slice(start, start + 1400);

  assert.match(zweig, /const seriesBody = \{ \.\.\.body \}/,
    'der Serien-Aufruf braucht einen eigenen Body, sonst wirkt jede Korrektur auch auf den Einzel-PUT');
  assert.match(zweig, /seriesBody\.account_id === null && entry\.account_id == null/,
    'ein leeres Feld zählt nur als "Konto entfernen", wenn die Instanz vorher eines trug');
  assert.match(zweig, /delete seriesBody\.account_id/,
    'sonst muss das Feld ungesendet bleiben - weglassen heißt serverseitig "unverändert"');
  assert.match(zweig, /api\.put\(`\/budget\/\$\{entry\.id\}\/series`, seriesBody\)/,
    'gesendet wird der bereinigte Body, nicht der ursprüngliche');
});

// --------------------------------------------------------
// Split-Ausgaben: EINE Neu-Aktion, und sie wohnt im Budget-Kopf
// --------------------------------------------------------

/**
 * Bis zur Critique 2026-09-25 brachte die eingebettete Aufteilung einen eigenen
 * Sekundaerknopf und einen eigenen FAB mit (`add: null` in TAB_CAPS, damit
 * Budgets generische Knoepfe nicht ZUSAETZLICH auftauchten - das waren einmal
 * vier Ausloeser fuer dieselbe Handlung). Der eigene FAB kannte aber die
 * geteilte Regel „wo ein beschrifteter Kopfknopf steht, schwebt keiner"
 * (`.toolbar-new-btn`, layout.css) nicht und schwebte am Desktop ueber
 * „87,50 €". Jetzt gilt dieselbe Grammatik wie auf jedem anderen Tab: der Kopf
 * traegt die Aktion, mobil der FAB des Budgets - und die Unterseite rendert
 * eingebettet KEINEN eigenen Ausloeser mehr. Es bleibt bei genau zwei (Kopf und
 * FAB), die CSS nie gleichzeitig zeigt.
 */
test('Split-Ausgaben legt ueber den Budget-Kopf an, nicht ueber eigene Knoepfe', () => {
  const table = budget.match(/const TAB_CAPS = \{[\s\S]*?\n\};/);
  assert.ok(table, 'TAB_CAPS-Tabelle fehlt');
  assert.match(table[0], /'split-expenses':\s*\{[^}]*add:\s*'splitExpenses\.addExpense'/,
    'die Aufteilung braucht die Neu-Aktion im Kopf wie jeder andere Tab');
  assert.match(withoutComments(budget), /case 'split-expenses':\s*openNewSplitExpense\(\); return;/,
    'Kopfknopf und FAB oeffnen den Ausgaben-Dialog der Unterseite');
  // Im Archiv gibt es keine neue Ausgabe - die Sperre fragt die Unterseite.
  assert.match(budget, /const splitBlocked = caps === TAB_CAPS\['split-expenses'\] && !canAddSplitExpense\(\);/);
  assert.match(budget, /onAddableChange: syncAddAction/, 'ein Archiv-Wechsel muss den Kopf nachziehen');
  // Die Unterseite rendert eingebettet weder Knopf noch FAB.
  const render = splitExpenses.slice(splitExpenses.indexOf('export async function render('), splitExpenses.indexOf('async function loadInitial('));
  assert.match(render, /const fab = embedded \? '' :/, 'eingebettet kein eigener #split-fab');
  assert.match(render, /const head = embedded\s*\? `<h2 class="sr-only">\$\{t\('splitExpenses\.tabLabel'\)\}<\/h2>`/,
    'eingebettet kein eigener Kopf mit Knopf - nur die Gliederungs-Ueberschrift');
});

/**
 * Eingebettet traegt das Panel keinen zweiten Seitentitel („Gemeinsame
 * Ausgaben") und keine Beschreibung mehr unter dem Tab „Aufteilung": EIN
 * Begriff, der Tab-Name. Fuer die Gliederung (Budget > Aufteilung > Gruppe >
 * Abschnitt) bleibt eine sr-only-<h2>, wie an Konten und Darlehen.
 */
test('eingebettete Split-Ausgaben tragen keinen zweiten sichtbaren Titel und kein <h1>', () => {
  const render = withoutComments(splitExpenses.slice(splitExpenses.indexOf('export async function render('), splitExpenses.indexOf('async function loadInitial(')));
  const embeddedHead = render.match(/const head = embedded\s*\?\s*(`[^`]*`)/)?.[1] ?? '';
  assert.match(embeddedHead, /class="sr-only"/, 'die eingebettete Ueberschrift ist nur fuer die Gliederung da');
  assert.doesNotMatch(embeddedHead, /splitExpenses\.(title|subtitle)|<h1/, 'kein zweiter Seitentitel, keine Beschreibung');
});

/**
 * Mit dem Tab-Titel als <h2> stand der Gruppenname auf derselben Stufe wie der
 * Titel, die Karten darunter auf <h3>. Eingebettet sinkt die Gliederung deshalb
 * eine Stufe: Budget > Split-Ausgaben > Gruppe > Abschnitt (Nachtrag aus dem
 * Review von #1148). Weil der Tag damit wechselt, darf die Optik nicht an ihm
 * haengen - ein Selektor wie `.split-card h3` griffe nur noch ausserhalb des Budgets.
 */
test('eingebettete Split-Ausgaben gliedern Gruppe und Karten eine Stufe tiefer', () => {
  const src = withoutHtmlComments(withoutComments(splitExpenses));
  assert.match(src, /_embedded = embedded;/,
    'render() muss den Einbettungs-Schalter festhalten, renderMain() bekommt ihn nicht übergeben');
  assert.match(src, /const GroupTag = _embedded \? 'h3' : 'h2'/,
    'der Gruppenname steht eingebettet unter dem <h2>-Tab-Titel, also <h3>');
  assert.match(src, /const SectionTag = _embedded \? 'h4' : 'h3'/,
    'die Karten stehen eingebettet unter dem Gruppennamen, also <h4>');
  assert.match(src, /<\$\{GroupTag\} class="split-group-name">/,
    'der Gruppenname muss über GroupTag gerendert werden');
  assert.equal((src.match(/<\$\{SectionTag\} class="split-card-title">/g) ?? []).length, 3,
    'Salden, letzte Ausgaben und Verlauf müssen über SectionTag gerendert werden');
  // Fest geschriebene Ueberschriften nur im Kopf von render(), und dort je
  // Zweig genau passend: eingebettet die sr-only-<h2>, eigenstaendig die <h1>.
  const outsideHead = src.replace(/const head = embedded[\s\S]*?<\/header>`;/, '');
  assert.doesNotMatch(outsideHead, /<h[1-6][\s>]/,
    'eine fest geschriebene Überschrift folgt der Einbettung nicht - über eine Tag-Variable rendern');

  const byTag = [];
  for (const file of readdirSync(new URL('../public/styles/', import.meta.url))) {
    if (!file.endsWith('.css')) continue;
    for (const { selector } of eachRule(read(`../public/styles/${file}`))) {
      if (/\.split[\w-]*[^,]*\bh[1-6]\b/.test(selector)) byTag.push(`${file}: ${selector}`);
    }
  }
  assert.deepEqual(byTag, [],
    'Split-Überschriften wechseln mit der Einbettung den Tag - Stile an die Klasse hängen, nicht an h2/h3');
});

/**
 * Löschen einer Gruppe ist unumkehrbar (die Gruppe fällt mitsamt ihrer
 * Ausgaben), Bearbeiten/Archivieren nicht - dieselbe Kapsel für alle drei
 * verwischte den Unterschied (UX-Review). Seit der Critique 2026-09-25 stehen
 * die drei samt „Mitglied hinzufuegen" im Werkzeug-Menue der Gruppe; die Regel
 * bleibt: Loeschen im Gefahrenton, als letzter Eintrag hinter einem Trenner.
 */
test('Gruppe löschen trägt eine andere Gewichtung als bearbeiten/archivieren', () => {
  const menu = splitExpenses.slice(splitExpenses.indexOf('function groupToolsMenuHtml('), splitExpenses.indexOf('function renderMain('));
  assert.match(menu, /item\('split-edit-group', 'pencil', t\('splitExpenses\.editGroup'\)\)/,
    'Bearbeiten bleibt eine gewöhnliche Aktion');
  assert.match(menu, /item\('split-archive-group', 'archive', t\('splitExpenses\.archiveGroup'\)\)/,
    'Archivieren bleibt eine gewöhnliche Aktion');
  assert.match(menu, /popover-menu__separator[\s\S]*item\('split-delete-group', 'trash-2', t\('splitExpenses\.deleteGroup'\), true\)\}\s*<\/div>/,
    'Löschen steht zuletzt, hinter einem Trenner, im Gefahrenton');
  // Sichtbar bleibt die haeufige Handlung, nicht fuenf Knoepfe.
  const main = splitExpenses.slice(splitExpenses.indexOf('function renderMain('), splitExpenses.indexOf('// So viele Namen stehen'));
  assert.match(main, /id="split-settle"[\s\S]*\$\{groupToolsMenuHtml\(\)\}/);
  assert.doesNotMatch(main, /id="split-(edit|archive|delete)-group"/, 'die Gruppenverwaltung steht im Menue, nicht als Icon-Knopfreihe');
});

// --------------------------------------------------------
// Mobil: Inhalt ueber den Falz (Critique 2026-09-25, Schritt 2)
// --------------------------------------------------------

/* DER BUDGETKOPF KLAPPT WIE DER KALENDER GANZ EIN. Mit dem blossen
 * Inline-Schnitt blieb der Titel auf seiner Zeile (Monatsstepper fuellt sie
 * mobil), der Kollaps sparte 14px (170 -> 156). Die Regel steht geteilt in
 * layout.css an `.page-toolbar--period`; ohne die Klasse gilt sie nicht. */
test('Budgetkopf traegt page-toolbar--period: eingeklappt verlaesst der Titel das Bild', () => {
  assert.match(budget, /<div class="page-toolbar[^"]*\bpage-toolbar--period\b[^"]*\bbudget-nav\b[^"]*">/,
    'der Budgetkopf fuehrt den Monat im Center-Slot und muss `page-toolbar--period` tragen');
  const rules = [...eachRule(layoutCss)];
  const title = rules.find((r) => r.selector.trim()
    === '.page-toolbar--period.page-toolbar--capped.is-collapsed > .page-toolbar__title');
  assert(title && /clip-path:\s*inset\(50%\)/.test(title.body) && /position:\s*absolute/.test(title.body),
    'die geteilte Regel muss den eingeklappten Titel aus dem Fluss nehmen und klippen');
  assert(title.at.some((a) => /max-width:\s*1023px/.test(a)), 'nur unterhalb der Desktop-Breite');
  const calendarCss = read('../public/styles/calendar.css');
  assert.doesNotMatch(calendarCss.replace(/\/\*[\s\S]*?\*\//g, ''), /\.cal-toolbar\.page-toolbar--capped\.is-collapsed/,
    'keine zweite, kalendereigene Kopie der Regel');
});

/* ZWEI SKALEN (Critique 2026-09-25, P2): eine gemeinsame Skala liess das
 * Gehalt die Ausgaben auf 2-68px druecken. Geprueft wird am gerenderten
 * Markup: die groesste AUSGABE fuellt ihre Bahn, egal wie gross das Gehalt ist,
 * und jede Richtung steht in einem eigenen, benannten Block. */
const kategorien = () => [
  { category: 'salary', income: 5050, expenses: 0, total: 5050 },
  { category: 'housing', income: 0, expenses: -1620.99, total: -1620.99 },
  { category: 'benefits', income: 500, expenses: 0, total: 500 },
  { category: 'food', income: 0, expenses: -482.75, total: -482.75 },
  { category: 'health', income: 0, expenses: -371.4, total: -371.4 },
  { category: 'leisure', income: 0, expenses: -234.98, total: -234.98 },
];
const scalesIn = (html, kind) => {
  const block = html.match(new RegExp(`<section class="budget-chart-block budget-chart-block--${kind}[\\s\\S]*?</section>`));
  assert.ok(block, `Block ${kind} fehlt`);
  return [...block[0].matchAll(/--bar-scale:([\d.]+)/g)].map((m) => Number(m[1]));
};

test('Kategorie-Diagramm: Einnahmen und Ausgaben je nach EIGENEM Maximum', () => {
  const html = budgetUi.renderCategoryBars(kategorien());
  const expenses = scalesIn(html, 'expenses');
  const income = scalesIn(html, 'income');
  assert.deepEqual(expenses.length, 4);
  assert.equal(expenses[0], 1, 'die groesste Ausgabe fuellt ihre Bahn - das Gehalt setzt nicht mehr die Skala');
  assert.equal(income[0], 1);
  assert.equal(income[1], Number((500 / 5050).toFixed(4)), 'innerhalb des Blocks bleibt der Anteil ehrlich');
  assert.equal(expenses[3], Number((234.98 / 1620.99).toFixed(4)));
  assert.match(html, /<h3 class="budget-chart-block__title" id="budget-chart-expenses-title">/,
    'die Richtung steht als Text im Gruppenlabel des Blocks');
  assert.match(html, /aria-labelledby="budget-chart-income-title"/);
  // Eine Kategorie mit Ein- UND Ausgaben steht in beiden Bloecken mit ihrer
  // eigenen Summe, nicht mit dem Saldo.
  const both = budgetUi.categoryBlocks([{ category: 'misc', income: 50, expenses: -200, total: -150 }]);
  assert.deepEqual(both.expenses.map((r) => r.amount), [-200]);
  assert.deepEqual(both.income.map((r) => r.amount), [50]);
  const summary = budgetUi.chartSummary(kategorien());
  assert.match(summary, /^budget\.expenses: /, 'die Textalternative spricht je Block');
  assert.match(summary, /\. budget\.income: /);
});

test('Kategorie-Diagramm: einspaltig fuehren die drei groessten Ausgaben, die Einnahmen stehen als Summe im Titel', () => {
  const html = budgetUi.renderCategoryBars(kategorien());
  const expensesBlock = html.match(/<section class="budget-chart-block budget-chart-block--expenses[^"]*"/)[0];
  assert.match(expensesBlock, /budget-chart-block--lead/, 'der Ausgaben-Block fuehrt');
  assert.equal((html.match(/budget-bar-row--lead/g) ?? []).length, 3, 'genau drei Zeilen tragen die Markierung');
  const incomeBlock = html.match(/<section class="budget-chart-block budget-chart-block--income[\s\S]*?<\/section>/)[0];
  assert.doesNotMatch(incomeBlock, /budget-bar-row--lead|budget-chart-block--lead/, 'Einnahmen fuellen nicht mehr auf');
  assert.equal((html.match(/class="budget-bar-row[ "]/g) ?? []).length, 6,
    'alle Zeilen bleiben im Markup - die Kuerzung ist eine Darstellung, keine Datenkuerzung');
  // Ohne Ausgaben fuehrt der Einnahmen-Block; ohne Verborgenes kein Knopf.
  const nurEinnahmen = budgetUi.renderCategoryBars([{ category: 'salary', income: 10, expenses: 0, total: 10 }]);
  assert.match(nurEinnahmen, /budget-chart-block--income budget-chart-block--lead/);
  assert.equal(budgetUi.chartHasMore(budgetUi.categoryBlocks(kategorien())), true);
  assert.equal(budgetUi.chartHasMore(budgetUi.categoryBlocks(kategorien().filter((c) => c.expenses && c.category !== 'leisure'))), false,
    'drei Ausgaben ohne Einnahmen: nichts verborgen, kein Knopf');
  assert.equal(budgetUi.CHART_LEAD, 3);

  const rules = [...eachRule(budgetCss)];
  const single = (r) => r.at.some((a) => /@container budget-page \(width < 960px\)/.test(a));
  const hide = rules.find((r) => single(r) && /\.budget-chart-section:not\(\.is-expanded\) \.budget-bar-row:not\(\.budget-bar-row--lead\)/.test(r.selector));
  // Die Statistik baut dieselben Bloecke OHNE Markierung - gekuerzt wird nur
  // in der Uebersicht, sonst verschwaende dort der ganze Vergleich (gemessen
  // bei 390px: „Nach Kategorie" ohne eine einzige Zeile).
  for (const sel of hide.selector.split(',')) {
    assert.match(sel.trim(), /^\.budget-overview /, `"${sel.trim()}" kuerzt auch die Statistik`);
  }
  assert(hide && /display:\s*none/.test(hide.body), 'einspaltig blenden die unmarkierten Zeilen aus');
  assert(/\.budget-chart-section:not\(\.is-expanded\) \.budget-chart-block:not\(\.budget-chart-block--lead\)/.test(hide.selector),
    '... und den Block, der nicht fuehrt');
  const incomeLine = rules.find((r) => single(r) && r.selector.trim() === '.budget-overview .budget-chart-section:not(.is-expanded) .budget-chart-head__income');
  assert(incomeLine && /display:\s*flex/.test(incomeLine.body), 'eingeklappt steht die Einnahmen-Summe unter dem Titel');
  const baseLine = rules.find((r) => r.at.length === 0 && r.selector.trim() === '.budget-chart-head__income');
  assert(baseLine && /display:\s*none/.test(baseLine.body), 'im Zweispalter steht der Block selbst - keine zweite Summe');
  assert(!rules.some((r) => !single(r) && /budget-bar-row--lead\)/.test(r.selector) && /display:\s*none/.test(r.body)),
    'ausserhalb der einspaltigen Lage wird nichts gekuerzt');
});

test('Kategorie-Diagramm: „Alle Kategorien (N)" steht im Kopf und meldet seinen Zustand', () => {
  const rules = [...eachRule(budgetCss)];
  const single = (r) => r.at.some((a) => /@container budget-page \(width < 960px\)/.test(a));
  const base = rules.find((r) => r.at.length === 0 && r.selector.trim() === '.budget-chart-more');
  assert(base && /display:\s*none/.test(base.body), 'im Zweispalter gibt es nichts aufzuklappen');
  const shown = rules.find((r) => single(r) && r.selector.trim() === '.budget-chart-more');
  assert(shown && !/display:\s*none/.test(shown.body), 'einspaltig steht der Knopf da');

  const src = withoutHtmlComments(budget);
  assert.match(src, /\$\{chartHasMore\(chartBlocks\) \? `\s*<button type="button" class="budget-chart-more" id="budget-chart-more"\s*aria-expanded="\$\{state\.categoriesExpanded \? 'true' : 'false'\}" aria-controls="budget-chart">/,
    'der Knopf erscheint nur, wenn einspaltig etwas verborgen ist, und meldet seinen Zustand');
  const head = src.match(/<div class="budget-chart-head">([\s\S]*?)<p class="sr-only">/);
  assert(head && head[1].includes('id="budget-chart-more"'), 'der Knopf steht in der Titelzeile, nicht als eigene Zeile');
  assert(head[1].includes('chartIncomeLine(chartBlocks)'), 'die Einnahmen-Summe teilt sich die Titelzeile');
});

/* EIN WERKZEUG-MENUE: Kategorien verwalten, CSV und die Gruppierung standen
 * als bis zu drei beschriftete Knoepfe im Listenkopf und brachen mobil um
 * (124px). Jetzt ein Knopf, die Werkzeuge im geteilten popover-menu. */
test('Listenkopf: Kategorien verwalten und CSV stehen in EINEM Menue, nicht als Knoepfe', () => {
  const vorher = { ...budgetUi.state };
  try {
    Object.assign(budgetUi.state, {
      month: '2026-09', budgetMode: 'shared', groupByResponsible: true,
      entries: [{ id: 1, total: -5, responsible_users: [{ id: 3, display_name: 'Linda' }] }],
    });
    const html = budgetUi.listToolsMenuHtml();
    assert.equal((html.match(/popovertarget="budget-list-tools-menu"/g) ?? []).length, 1, 'genau ein Ausloeser');
    assert.equal((html.match(/<button\b/g) ?? []).length, 3, 'Ausloeser + Gruppierung + Kategorien, nichts sonst als Knopf');
    const menu = html.slice(html.indexOf('<div class="popover-menu'));
    assert.match(menu, /role="menu"/);
    assert.match(menu, /id="budget-manage-categories"[\s\S]*budget\.manageCategories/, 'Kategorien verwalten im Menue');
    assert.match(menu, /<a role="menuitem" class="popover-menu__item budget-csv-export" href="\/api\/v1\/budget\/export\?month=2026-09"/,
      'der CSV-Export ist ein Menue-Link auf denselben Endpunkt');
    assert.match(menu, /role="menuitemcheckbox" aria-checked="true"[^>]*id="budget-group-responsible"/,
      'die Gruppierung ist ein Umschalter mit Zustand');
    assert.doesNotMatch(html, /class="btn btn--secondary budget-(manage-categories|csv-export)/,
      'kein beschrifteter Einzelknopf mehr im Listenkopf');

    Object.assign(budgetUi.state, { entries: [] });
    const leer = budgetUi.listToolsMenuHtml();
    assert.doesNotMatch(leer, /budget-csv-export|budget-group-responsible/, 'leerer Monat: kein Export, keine Gruppierung');
  } finally {
    Object.assign(budgetUi.state, vorher);
  }
  const src = withoutHtmlComments(budget);
  assert.match(src, /<div class="budget-list-header__actions">\$\{listToolsMenuHtml\(\)\}<\/div>/,
    'der Listenkopf rendert nur das Menue');
  assert.match(src, /installPopoverMenus\(container\)/, 'Position, Schliessen und Pfeiltasten an der stabilen Wurzel');
});

/* SALDO ALS KOPFWERT, TRENDS WIEDER DA. Unter 640px stand die Saldo-Karte
 * allein in einer vollen Zeile unter zwei halben, und der Vormonatstrend war
 * unter 480px Container ausgeblendet. */
test('Kennzahlen mobil: Saldo als Kopfwert vor Einnahmen/Ausgaben, Trend sichtbar', () => {
  const rules = [...eachRule(budgetCss)];
  const hidden = rules.filter((r) => /\.metric-card__trend\b/.test(r.selector) && /display:\s*none/.test(r.body));
  assert.deepEqual(hidden.map((r) => r.selector), [], 'der Vormonatstrend darf auf keiner Breite ausgeblendet sein');
  const band = rules.find((r) => r.at.some((a) => /max-width:\s*639px/.test(a))
    && r.selector.trim() === '.budget-overview .metric-grid:not(.metric-grid--expenses-only) > .metric-card:last-child');
  assert(band, 'keine Kopfwert-Regel fuer die Saldo-Karte unter 640px');
  assert.match(band.body, /order:\s*-1/, 'der Saldo steht vor seiner Herleitung');
  assert.match(band.body, /grid-template-areas:\s*"label value"\s*"trend value"/,
    'Label und Trend links, der Betrag rechts - eine flache Zeile statt einer vollen Karte');
  const rows = rules.find((r) => r.at.some((a) => /max-width:\s*639px/.test(a))
    && r.selector.trim() === '.budget-overview .metric-grid:not(.metric-grid--expenses-only)');
  assert(rows && /grid-auto-rows:\s*auto/.test(rows.body),
    'ohne auto zoege die geteilte 1fr-Regel den flachen Kopfwert auf Kartenhoehe auf');
});

// --------------------------------------------------------
// Betraege mit gleich breiten Ziffern (Critique 2026-09-25, Schritt 3)
// --------------------------------------------------------

/**
 * Jeder Betrag des Budget-Moduls steht in `tabular-nums`: sonst springen
 * Spalten von Betraegen je nach Ziffernform („1,11 €" schmaler als „8,88 €"),
 * und untereinander stehende Summen fluchten nicht. Gemessen fehlte die Regel
 * an Konten, Darlehen, Statistik, Abos und Aufteilung.
 *
 * ZWEI QUELLEN, damit der Guard nicht an einer Liste erblindet: die benannten
 * Betragsklassen aus der Critique UND jede Klasse, deren Element im Markup
 * direkt einen Betrag rendert (`${money(`, `${formatAmount(`, ...). Gedeckt
 * ist eine Klasse, wenn eine Regel mit `tabular-nums` sie im letzten Glied
 * ihres Selektors nennt - `font-variant-numeric` erbt, also deckt auch der
 * Traeger (`.split-debt`) sein `<strong>`.
 */
test('Betraege im Budget-Modul stehen in tabular-nums (benannt und aus dem Markup)', () => {
  const sheets = ['budget', 'subscriptions', 'split-expenses', 'panel', 'layout', 'list-row', 'typography']
    .map((name) => read(`../public/styles/${name}.css`));
  const tabular = [];
  for (const src of sheets) {
    for (const rule of eachRule(src)) {
      if (/font-variant-numeric:\s*tabular-nums/.test(rule.body)) {
        tabular.push(...rule.selector.split(',').map((part) => part.trim()));
      }
    }
  }
  const lastCompound = (selector) => selector.split(/[\s>+~]+/).filter(Boolean).pop() ?? '';
  const classesOf = (selector) => [...selector.matchAll(/\.([\w-]+)/g)].map((m) => m[1]);
  const covered = (selector) => tabular.includes(selector)
    || classesOf(selector).some((cls) => tabular.some((tab) => classesOf(lastCompound(tab)).includes(cls)));

  const named = [
    '.budget-account__balance', '.budget-account__starting', '.subscriptions-chart-row > strong',
    '.subscription-card__cost', '.subscriptions-chart__figure strong', '.split-expense__amount',
    '.split-debt strong', '.budget-loan-card__amounts span', '.budget-loans__summary',
    '.budget-stats__readout', '.budget-stats__legend-item', '.metric-card__trend',
  ];

  const pages = ['budget.js', 'budget-stats.js', 'budget-plans.js', 'subscriptions.js', 'split-expenses.js'];
  const amountFn = String.raw`\$\{\s*(?:money|fmt|formatAmount|formatMoney)\(`;
  const direct = new RegExp(String.raw`<\w+\s+class="([^"]*)"[^>]*>[^<]{0,160}?` + amountFn, 'g');
  const wrapped = new RegExp(String.raw`<\w+\s+class="([^"]*)"[^>]*>\s*<\w+[^>]*>\s*` + amountFn, 'g');
  const derived = new Set();
  for (const page of pages) {
    const src = read(`../public/pages/${page}`);
    for (const re of [direct, wrapped]) {
      for (const m of src.matchAll(re)) {
        const first = m[1].split(/\s+/).find((cls) => cls && !cls.includes('$'));
        if (first) derived.add(`.${first}`);
      }
    }
  }
  assert.ok(derived.size >= 6, `nur ${derived.size} Betragsklassen im Markup gefunden - misst der Scanner noch?`);

  const missing = [...new Set([...named, ...derived])].filter((selector) => !covered(selector));
  assert.deepEqual(missing, [], `Betraege ohne tabular-nums: ${missing.join(', ')}`);
});

// --------------------------------------------------------
// Critique 2026-09-25, Schritt 4: Aussage, Statistik, Kleinbefunde
// --------------------------------------------------------

/** Laesst den echten Render-Pfad der Uebersicht laufen und gibt ihr Markup zurueck. */
function uebersicht(extra = {}) {
  const vorher = { ...budgetUi.state };
  Object.assign(budgetUi.state, {
    activeTab: 'budget', loadError: null, prevSummary: null, entries: [],
    summary: { income: 0, expenses: 0, balance: 0, byCategory: [], pending: { count: 0 } },
    responsibleFilterId: null, groupByResponsible: false, accountFilterId: null, expensesOnly: false,
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
    budgetUi.renderBodyForTest(container);
  } finally {
    Object.assign(budgetUi.state, vorher);
  }
  return html;
}

const monthKey = (offset) => {
  const [y, m] = todayKey().split('-').map(Number);
  const d = new Date(y, m - 1 + offset, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
};
const zeile = (over = {}) => ({
  id: 41, title: 'Miete', amount: -950, date: `${monthKey(0)}-01`, category: 'housing',
  account_id: null, is_recurring: 0, attachments: [], is_pending: 0, responsible_users: [], ...over,
});
const summe = { income: 3000, expenses: -950, balance: 2050, byCategory: [], pending: { count: 0 } };

test('Zukunftsmonat: die Bilanz heisst Prognose, der Saldo verliert den Ton der Tatsache', () => {
  const zukunft = uebersicht({ month: monthKey(1), entries: [zeile({ date: `${monthKey(1)}-01` })], summary: summe });
  assert.match(zukunft, /id="budget-summary-title">budget\.summaryTitleForecast</, 'der Titel sagt es als Text');
  assert.match(zukunft, /class="metric-card metric-card--forecast"/);
  assert.doesNotMatch(zukunft, /metric-card--balance-positive/, 'kein gruener Saldo fuer Geld, das nicht geflossen ist');
  const jetzt = uebersicht({ month: monthKey(0), entries: [zeile()], summary: summe });
  assert.match(jetzt, /id="budget-summary-title">budget\.summaryTitle</);
  assert.match(jetzt, /metric-card--balance-positive/, 'der laufende Monat bleibt eine Bilanz');
  const rule = [...eachRule(panelCss)].find((r) => r.selector.trim() === '.metric-card--forecast .metric-card__value');
  assert(rule && /--color-text-secondary/.test(rule.body));
});

test('Zeilen nach heute: Ring statt Punkt, im laufenden Monat mit benanntem Symbol', () => {
  const morgen = todayKey() < `${monthKey(0)}-28` ? `${monthKey(0)}-28` : null;
  if (morgen) {
    const html = uebersicht({ month: monthKey(0), entries: [zeile({ date: morgen }), zeile({ id: 42, date: `${monthKey(0)}-01` })], summary: summe });
    assert.equal((html.match(/budget-entry--upcoming/g) ?? []).length, 1, 'nur die Zeile nach heute');
    assert.match(html, /role="img" aria-label="budget\.upcomingLabel"/);
  }
  const zukunft = uebersicht({ month: monthKey(1), entries: [zeile({ date: `${monthKey(1)}-02` })], summary: summe });
  assert.match(zukunft, /budget-entry--upcoming/);
  assert.doesNotMatch(zukunft, /budget\.upcomingLabel/, 'im Prognose-Monat sagt es der Titel, nicht jede Zeile');
  const erwartet = uebersicht({ month: monthKey(1), entries: [zeile({ date: `${monthKey(1)}-02`, is_pending: 1 })], summary: summe });
  assert.doesNotMatch(erwartet, /budget-entry--upcoming/, 'eine erwartete Buchung hat ihre eigene Markierung');
  const ring = [...eachRule(budgetCss)].find((r) => r.selector.trim() === '.budget-entry--upcoming .budget-entry__indicator');
  assert(ring && /background-color:\s*transparent/.test(ring.body) && /box-shadow/.test(ring.body), 'Form statt Farbe');
});

test('Kennzahlen: Einnahmen und Ausgaben in Label-Farbe, Farbe nur am Saldo und am Trend', () => {
  for (const kind of ['income', 'expenses']) {
    const rule = [...eachRule(panelCss)].find((r) => r.selector.trim() === `.metric-card--${kind}   .metric-card__value`
      || r.selector.trim() === `.metric-card--${kind} .metric-card__value`);
    assert.ok(rule, `.metric-card--${kind} fehlt`);
    assert.match(rule.body, /var\(--color-text-primary\)/);
    assert.doesNotMatch(rule.body, /--color-(success|danger)/, `${kind}: 28px Rot/Gruen ist konkurrierender Alarm`);
  }
  const bar = [...eachRule(budgetCss)].filter((r) => r.at.length === 0 && r.selector.trim() === '.budget-bar-row__amount');
  assert.ok(bar.some((r) => /color:\s*var\(--color-text-primary\)/.test(r.body)), 'Kategoriebetraege in Label-Farbe, den Ton traegt der Balken');
  assert.doesNotMatch(budget, /class="budget-bar-row__amount" style="color:/);
});

test('Loeschknoepfe nennen, WAS sie loeschen', () => {
  const vorher = { ...budgetUi.state };
  try {
    Object.assign(budgetUi.state, { entries: [zeile(), zeile({ id: 42, title: 'Strom' })], responsibleFilterId: null, groupByResponsible: false });
    const html = budgetUi.renderEntries();
    const names = [...html.matchAll(/data-action="delete"[^>]*aria-label="([^"]*)"/g)].map((m) => m[1]);
    assert.equal(names.length, 2);
    assert.notEqual(names[0], names[1], '23 gleichnamige „Eintrag loeschen" waren nicht unterscheidbar');
  } finally { Object.assign(budgetUi.state, vorher); }
  assert.match(budget, /data-action="delete" data-id="\$\{e\.id\}" aria-label="\$\{esc\(t\('budget\.deleteLabel', \{ title: e\.title \}\)\)\}"/);
  assert.match(budget, /id="bm-delete" aria-label="\$\{esc\(t\('budget\.deleteLabel', \{ title: entry\.title \}\)\)\}"/);
  const de = JSON.parse(read('../public/locales/de.json'));
  assert.match(de.budget.deleteLabel, /\{\{title\}\}/);
});

test('der Titel-Knopf einer Buchung trifft auf seiner ganzen Hoehe', () => {
  // Gemessen 34-35px von 44px: die Meta-Zeile malte sich ueber das Polster.
  const title = [...eachRule(budgetCss)].find((r) => r.selector.trim() === 'button.budget-entry__title');
  assert.match(title.body, /position:\s*relative/);
  assert.match(title.body, /z-index:\s*1/);
  const chip = [...eachRule(budgetCss)].find((r) => r.selector.trim() === '.budget-responsible-chip');
  assert.match(chip.body, /z-index:\s*2/, 'der Zustaendigen-Chip in der Meta-Zeile bleibt treffbar');
});

test('Buchungsdialog: Betrag zuerst und gross, Seltenes hinter „Weitere Angaben", Formularbreite', () => {
  const start = budget.indexOf('function openBudgetModal(');
  const modal = budget.slice(start, budget.indexOf('\nfunction ', start + 10));
  const pos = (needle) => { const i = modal.indexOf(needle); assert.ok(i >= 0, `${needle} fehlt`); return i; };
  assert.ok(pos('id="bm-amount"') < pos('id="bm-title"'), 'der Betrag steht vor dem Titel - und bekommt als erstes Feld den Erstfokus');
  assert.ok(pos('id="bm-title"') < pos('id="bm-category"'));
  assert.ok(pos('id="bm-category"') < pos('id="bm-date"'));
  assert.match(modal, /class="form-input budget-amount-input" id="bm-amount"/);
  assert.match(modal, /inputmode="decimal"/);
  const adv = pos('${advancedSection(`');
  for (const rare of ['${accountField}', 'id="bm-visibility"', 'responsiblePickerHtml(', 'id="bm-recurring"', 'renderDocumentAttachField(']) {
    assert.ok(pos(rare) > adv, `${rare} gehoert hinter „Weitere Angaben"`);
  }
  assert.ok(pos('id="bm-date"') < adv);
  assert.match(modal, /label: t\('budget\.moreDetails'\)/);
  assert.match(modal, /entry\.responsible_users\?\.length/, 'eine gesetzte Zustaendigkeit oeffnet den Riegel beim Bearbeiten');
  assert.match(modal, /size: 'md'/, '400px fuer zehn Felder waren schmaler als jeder andere Formulardialog');
  const input = [...eachRule(budgetCss)].find((r) => r.selector.trim() === '.budget-amount-input');
  assert.match(input.body, /font-variant-numeric:\s*tabular-nums/);
  assert.match(input.body, /font-size:\s*var\(--text-xl\)/);
  const add = [...eachRule(budgetCss)].find((r) => r.selector.trim() === '.budget-inline-add::before');
  assert.ok(add && /height:\s*var\(--target-base\)/.test(add.body), '„+ Kategorie" traf nur 25px');
  const head = [...eachRule(budgetCss)].find((r) => r.selector.trim() === '.budget-field-header');
  assert.match(head.body, /min-height:\s*var\(--target-base\)/, 'die Zeile fasst die Treffflaeche, ohne sie ins Feld darunter ragen zu lassen');
});

test('Darlehen: hoechstens ein Primaerknopf - die Rate buchen ist sekundaer', () => {
  const card = budgetUi.renderLoanCard({
    id: 1, title: 'Auto', borrower: 'Mike', direction: 'lent', paid_amount: 200, total_amount: 1200,
    remaining_amount: 1000, paid_installments: 1, installment_count: 6, next_due_month: monthKey(1), currency: 'EUR',
  });
  assert.match(card, /data-action="loan-pay"/);
  assert.doesNotMatch(card, /btn--primary/, 'drei Darlehen zeigten drei violette Primaerknoepfe');
});

test('Statistik wiederholt die Uebersicht nicht: Vergleich je Kategorie und aufsummierter Verlauf', () => {
  const src = withoutHtmlComments(stats);
  assert.doesNotMatch(src, /class="metric-grid"|metric-card--income|metric-card--expenses/,
    'die drei Kennzahl-Karten der Uebersicht standen hier 1:1 noch einmal');
  assert.match(src, /api\.get\(`\/budget\/stats\?range=\$\{view\.range\}&anchor=\$\{addLocalDays\(data\.from, -1\)\}/,
    'der Vorzeitraum kommt vom selben Endpunkt, verankert am Tag davor');
  assert.match(src, /trendMarkup\(\{ delta, betterWhen/, 'die Veraenderung spricht die Trend-Sprache der Karten');
  assert.match(src, /budgetMaxOwn|const max = Math\.max\(\.\.\.rows\.map/, 'jeder Block nach seinem eigenen Maximum');
  assert.match(src, /const cumulative = s\.length > 0 && /);
  assert.match(src, /cumulative \? running\(rawIncomes\) : rawIncomes/);
  assert.match(src, /statsTrendTitleCumulative/);
  const wiring = src.match(/function wireTrendPoints[\s\S]*?\n\}/)[0];
  assert.match(wiring, /addEventListener\('pointermove'/, 'die ganze Flaeche waehlt den naechsten Tag - ein Punkt war 10-24px breit');
});

/**
 * Abo-Zeile: die Metaangaben ueberdecken den Betrag nie (Re-Critique 2026-09-25).
 * Die Zeile steht NEBEN dem Betrag - die Textspalte darf schrumpfen, der Betrag
 * nicht. Mit `white-space: nowrap` an jeder Metaangabe war „24.09.2026 · 2 Tage
 * ueberfaellig" EIN unzerbrechliches Stueck: breiter als die Textspalte (390px,
 * de) ragte es 6px unter den Betrag. Die Regel: keine Angabe in der Metazeile ist
 * unzerbrechlich, Datum und Relativangabe sind getrennte Einheiten in einem
 * umbrechenden Traeger - die Zeile bricht ZWISCHEN ihnen um, und eine Einheit,
 * die allein breiter ist als die Spalte, bricht in sich statt zu ueberlaufen.
 * Der Ueberfaellig-Hinweis ist eine Warnung und wird nie abgeschnitten.
 */
test('Abo-Zeile: Metaangaben brechen um statt unter den Betrag zu laufen', async () => {
  const rules = [...eachRule(subscriptionsCss)];
  const parts = (selector) => selector.split(',').map((part) => part.trim());
  const meta = rules.filter(({ selector }) => parts(selector)
    .some((sel) => /\.subscription-card__(?:meta|due)\b/.test(sel)));
  assert.ok(meta.length >= 3, 'Regeln der Metazeile nicht gefunden');
  for (const { selector, body } of meta) {
    assert.doesNotMatch(body, /white-space:\s*(?:nowrap|pre)\b/,
      `${selector}: ein unzerbrechliches Stueck in der Metazeile laeuft unter den Betrag`);
    assert.doesNotMatch(body, /text-overflow:\s*ellipsis|overflow:\s*hidden/,
      `${selector}: der Ueberfaellig-Hinweis ist eine Warnung und wird nicht abgeschnitten`);
  }
  const base = (sel) => rules.find(({ selector, at }) => at.length === 0 && parts(selector).includes(sel))?.body ?? '';
  assert.match(base('.subscription-card__meta'), /flex-wrap:\s*wrap/);
  assert.match(base('.subscription-card__due'), /flex-wrap:\s*wrap/,
    'Datum und Relativangabe umbrechen als zwei Einheiten');
  assert.match(base('.subscription-card__body'), /min-width:\s*0/, 'die Textspalte darf schrumpfen');
  const columns = base('.subscription-card__main').match(/grid-template-columns:\s*([^;]+)/)?.[1] ?? '';
  assert.match(columns, /^auto\s+minmax\(0,\s*1fr\)\s+auto$/, 'Marke fest, Text schrumpft, Betrag als eigene Spalte');
  assert.match(base('.subscription-card__cost'), /white-space:\s*nowrap/, 'der Betrag schrumpft nicht');

  const { __test: abos } = await import('../public/pages/subscriptions.js');
  const html = abos.renderCard({
    id: 7, name: 'Streaming', description: '', status: 'active', enabled: 1, amount: 39, currency: 'EUR',
    monthly_base: 39, next_payment_date: '2020-01-01', billing_cycle: 'monthly', cycle_interval: 1,
    reminder_days: 3, end_type: 'never',
  });
  // Inhalt des Faelligkeits-Elements ueber die Verschachtelung, nicht bis zum ersten `</span>`.
  const open = '<span class="subscription-card__due subscription-card__due--overdue">';
  const start = html.indexOf(open);
  let due;
  if (start >= 0) {
    const tags = /<\/?span\b[^>]*>/g;
    tags.lastIndex = start + open.length;
    for (let depth = 1, m; (m = tags.exec(html));) {
      depth += m[0].startsWith('</') ? -1 : 1;
      if (depth === 0) { due = html.slice(start + open.length, m.index); break; }
    }
  }
  assert.ok(due, 'ueberfaellige Faelligkeit nicht gefunden');
  const units = [...due.matchAll(/<span[^>]*>([^<]*)<\/span>/g)].map((m) => m[1].trim());
  assert.equal(units.length, 2, `Datum und Relativangabe sind getrennte Einheiten: ${due}`);
  assert.match(units[1], /overdueDays/, 'die zweite Einheit ist der Ueberfaellig-Hinweis');
  // Zerlegen statt Ersetzen: gefragt ist nur, ob zwischen den Einheiten etwas
  // steht - ein Ersetzen liest sich fuer CodeQL wie eine HTML-Bereinigung.
  const loose = due.split(/<span[^>]*>[^<]*<\/span>|<i[^>]*><\/i>/).filter((teil) => teil.trim() !== '');
  assert.deepEqual(loose, [], 'ausserhalb der beiden Einheiten steht kein loser Text');
});
