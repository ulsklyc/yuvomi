/**
 * Module: Split Expenses
 * Purpose: Mobile-first shared expense groups, balances, settlements, and activity.
 */

import { api } from '/api.js';
import { openModal as openSharedModal, closeModal, confirmModal, confirmOverModal, askOverModal, reportFieldError, reportFieldErrors, constraintErrors, refocusAfterRender, whenModalClosed, captureModalContext, captureOpenContext, isModalContextCurrent, isOwnModalOpen, advancedSection } from '/components/modal.js';
import { renderDocumentAttachField, bindDocumentAttachField, attachmentLinksNode } from '/components/document-attach.js';
import { openDetailView, closeDetailView, withPrimaryEdit } from '/components/detail-view.js';
import { t, getLocale, getNumberFormat, dateInputPlaceholder, parseDateInput, isDateInputValid } from '/i18n.js';
import { dateText } from '/utils/date-format.js';
import { esc, REQUIRED_MARK } from '/utils/html.js';
import { rowActionHtml } from '/utils/row-action.js';
import { installPopoverMenus, popoverMenuHtml } from '/utils/popover-menu.js';
import { renderPageSearch, wirePageSearch } from '/utils/page-search.js';
import { stagger, scheduleUndoableDelete } from '/utils/ux.js';
import { errorSentence } from '/utils/friendly-error.js';
import { redrawList, collapseRow } from '/utils/list-motion.js';
import { swapContent } from '/utils/content-swap.js';
import { renderSkeletonList } from '/utils/skeleton.js';
import { formatMoney, amountPlaceholder, toAmountDecimalString, amountInputProblem, amountToInput, toStoredNumber } from '/utils/money.js';
// Der Satz zu einem Grund: derselbe Baustein wie in jedem Betragsfeld (D1).
import { amountProblemText } from '/utils/amount-field.js';
import { todayKey } from '/utils/date.js';
import { nextRunNotBefore } from '/utils/interval-date.js';
import { zonedDateKey } from '/utils/timezone.js';
import { wireTablist } from '/utils/tablist.js';
import { attachSegmentIndicator } from '/utils/segment-indicator.js';
import { findPageFab } from '/utils/fab.js';
import { emptyStateHTML, searchEmptyHTML } from '/utils/empty-state.js';
import { metricGlanceHtml, wireMetricGlance, metricGlanceSkeletonHtml, metricCardsSkeletonHtml } from '/utils/metric-glance.js';
import { isNavModuleReadOnly } from '/permissions.js';
import { categoryPaint } from '/utils/budget-category-colors.js';
import { budgetCategoryLabel } from '/utils/category-labels.js';
import { amountFieldHtml } from '/utils/amount-field.js';
import { filterButtonHtml, syncFilterButton, openFilterSheet, filterChipHtml } from '/utils/filter-sheet.js';
import { initials } from '/utils/initials.js';
import { safeHexColor, getReadableTextColor } from '/utils/color.js';

let state = {
  meta: null,
  dashboard: null,
  groups: [],
  members: [],
  groupMembers: [],
  memberCandidates: [],
  activeGroupId: null,
  expenses: [],
  // Ausgabenliste seitenweise (#2108), wie der Verlauf: der Cursor der
  // naechsten Seite aus `pagination.next_cursor` (null = alles geladen), und zu
  // welcher Frage (Gruppe + Kategorie) die geladene Liste gehoert - nur bei
  // DERSELBEN bleibt ihre Tiefe beim Neuladen.
  expensesCursor: null,
  expensesKey: null,
  expensesLoadingMore: false,
  // Wiederkehrende Ausgaben der aktiven Gruppe (#1647), wie der Server sie
  // dieser Anfrage zeigt: samt `can_edit`, `blocked_reason` und - pausiert -
  // `missed_count` / `resume_date`.
  recurring: [],
  balances: { balances: [], simplified_debts: [] },
  activity: [],
  // Verlauf seitenweise (#1309): der Cursor der naechsten Seite, wie ihn der
  // Server in `pagination.next_cursor` liefert (null = alles geladen), und die
  // Gruppe, zu der `activity` gehoert - nur innerhalb DERSELBEN Gruppe bleibt
  // die geladene Tiefe bei einem Neuladen erhalten.
  activityCursor: null,
  activityGroupId: null,
  activityLoadingMore: false,
  query: '',
  // Der Kategoriefilter (R24, E12): ein Schluessel der Budget-Kategorien,
  // 'none' fuer "ohne Kategorie", '' fuer alle.
  category: '',
  // Die Ausgaben-Kategorien des Budgets ({ key, name }), aus /budget/meta.
  // Die Aufteilung fuehrt seit R24 dieselben (Migration 271).
  budgetCategories: [],
  // Statusfilter der Gruppenliste (#574): 'archived' zeigt das Archiv
  // schreibgeschützt, inklusive Weg zurück über restoreGroup().
  groupStatus: 'active',
  user: null,
};
let _container = null;
// Eingebettet (siehe render) sinkt die ganze Gliederung um eine Stufe: der Tab-Titel
// ist <h2>, also Gruppenname <h3> und Karten <h4> - Budget > Split-Ausgaben > Gruppe
// > Abschnitt (Nachtrag aus dem Review von #1148). Die Optik haengt an Klassen
// (.split-group-name, .u-section-title), nicht am Tag.
let _embedded = false;

/* UEBERGABE AUS DEM BUDGET (#1057).
 *
 * Eine Buchung mit Zustaendigen kann in die geteilten Ausgaben gereicht werden,
 * mit den Zustaendigen als Beteiligte. Das ist der Uebergang, den das Ticket
 * ausdruecklich statt einer Verschmelzung der beiden Funktionen wollte: das
 * Etikett im Budget bleibt eine Zuschreibung, die Forderung entsteht erst hier,
 * und der Nutzer bestaetigt sie im Dialog.
 *
 * DER DIALOG WIRD NICHT UEBERSPRUNGEN. Die Aufteilung, die Waehrung und die
 * Gruppe sind Entscheidungen, die das Budget nicht treffen kann - vorbefuellt
 * wird, was es weiss, den Rest sieht und bestaetigt die Person davor.
 */
let _pendingPrefill = null;

export function prefillSplitExpense(data) {
  _pendingPrefill = data ?? null;
}
let _statusTablist = null;   // wireTablist-Handle des Statusfilters (sync ohne onChange)
// Eingebettet meldet die Seite dem Budget-Kopf, wenn sich aendert, ob eine neue
// Ausgabe gerade moeglich ist (Archiv an/aus) - der Kopfknopf gehoert budget.js.
let _onAddableChange = null;

// Die Gruppenwahl ist schmal EINE Zeile (R16): die aktive Gruppe als Kopf,
// die Liste samt Suche, „+" und Aktiv/Archiviert klappt darunter auf. Der
// Merker gilt nur fuer die schmale Bauart (split-expenses.css); breit steht
// die Liste immer.
let _groupPickerOpen = false;
let _groupSearch = null;    // wirePageSearch-Handle der Gruppensuche (Zuruecksetzen aus dem Leerzustand)

/**
 * Darf dieser Nutzer hier schreiben? (#467, #1265 P7)
 *
 * `budget`, nicht ein eigenes Modul: `server/scopes.js` fuehrt
 * `split-expenses` als zweiten Praefix von `budget`, und die Rechte kennen
 * keinen Schluessel `split-expenses` - eine Frage danach fiele still auf
 * `write` (die Falle, in die `birthdays.js` in P1 lief). Dasselbe gilt fuer
 * einen Gast: auch seine Schreibwege misst der Server an `budget`.
 *
 * NICHT zu verwechseln mit dem Archiv (`isArchivedView()`): das ist eine
 * Eigenschaft der GRUPPE, dies eine des NUTZERS. Beide fuehren zur selben
 * Leseansicht, aber aus verschiedenen Gruenden - und nur das Archiv bietet
 * „Wiederherstellen" an, weil das dort ein Schreibrecht voraussetzt, das
 * der Nutzer hat.
 */
function readOnly() {
  return isNavModuleReadOnly('budget');
}

function setHtml(element, html) {
  element.replaceChildren();
  element.insertAdjacentHTML('beforeend', html);
}

// Format aus utils/money.js - EINE Quelle für das ganze Budget-Modul (Critique
// P0). Geteilte Ausgaben tragen die Rolle `plain`: ein Rechnungsposten der
// Gruppe ist keine Bewegung auf dem Konto des Betrachters, wer ihn ausgelegt
// hat, hat eine Forderung und kein Minus. Die Rollentabelle steht in money.js.
function money(amount, currency) {
  const n = Number(amount || 0);
  if (!Number.isFinite(n)) return `${amount} ${currency}`;
  return formatMoney(n, currency);
}

/**
 * DER TYP EINER GRUPPE, WENN ER ETWAS SAGT (R22, D9). Die Gruppe "Haushalt"
 * vom Typ Haushalt stand als "Haushalt / Haushalt" im Kopf und als
 * "Haushalt · Haushalt · 2 Mitglieder" in der Wahl. Gleicht der Typ dem
 * Namen, faellt er weg; das Zeichen der Kachel sagt ihn weiter.
 */
function groupTypeLabel(group) {
  const label = t(`splitExpenses.groupType.${group.type}`);
  const same = String(group.name ?? '').trim().toLocaleLowerCase(getLocale()) === String(label).trim().toLocaleLowerCase(getLocale());
  return same ? '' : label;
}

function groupIcon(type) {
  return {
    household: 'home',
    couple: 'heart',
    travel: 'plane',
    event: 'party-popper',
    shopping: 'shopping-cart',
    general: 'users',
  }[type] || 'users';
}

/**
 * Kopf der Gruppenliste: Titel mit Zahl, Suche und das "..." mit "Gruppe
 * anlegen" (`data-action="add-group"`, gebunden in `bindShell`). Eigene
 * Funktion, damit der Test das echte Markup liest statt eines Selektors,
 * den er sich selbst zurueckgibt (#2119).
 */
function groupsPanelHeadHtml(embedded) {
  return `
          <div class="split-panel-head section-toolbar">
            <${embedded ? 'h3' : 'h2'} class="split-panel-title u-section-title">${t('splitExpenses.groups')}<span class="list-group__count split-panel-count" id="split-group-count"></span></${embedded ? 'h3' : 'h2'}>
            ${renderPageSearch({
    id: 'split-group-search',
    label: t('splitExpenses.searchGroups'),
    placeholder: t('splitExpenses.searchGroups'),
    value: state.query,
    clearLabel: t('common.searchClear'),
    className: 'split-search',
  })}
            ${readOnly() || isSplitGuest() ? '' : popoverMenuHtml({
    id: 'split-section-tools',
    label: t('common.moreActions'),
    items: [{ icon: 'plus', label: t('splitExpenses.addGroup'), action: 'add-group' }],
    triggerClass: 'btn btn--secondary btn--icon btn--sm split-section-tools',
  })}
          </div>`;
}

export async function render(container, { user, embedded = false, onAddableChange = null } = {}) {
  _container = container;
  _embedded = embedded;
  _onAddableChange = onAddableChange;
  state.user = user || null;
  // `split`, nicht `reading`: Kopf und Kennzahlenband stehen ueber einem
  // zweispaltigen .split-layout (Gruppen links, Detail rechts) - das IST die
  // Bauart des Modus. Das Raster selbst traegt die Seite noch in eigenem CSS
  // (Container-Queries statt Viewport-Breite, siehe split-expenses.css);
  // das Shell-Raster wirkt nur auf .app-page__body, den es hier nicht gibt.
  //
  // EINGEBETTET (budget.js ruft immer mit embedded:true - es gibt heute keine
  // eigenstaendige Route) TRAEGT DAS PANEL KEINEN EIGENEN KOPF MEHR
  // (Critique 2026-09-25): hier standen ein zweiter Seitentitel („Gemeinsame
  // Ausgaben"), eine Beschreibung und ein Sekundaerknopf, obwohl der Tab
  // „Aufteilung" heisst und der Budget-Kopf die Seite schon benennt. Der Tab-
  // Name bleibt der EINE Begriff; die Ueberschrift steht fuer die Gliederung
  // als sr-only-<h2> (Budget > Aufteilung > Gruppe > Abschnitt), wie Konten und
  // Darlehen. „Ausgabe hinzufuegen" ist der FAB des Budgets (#fab-new-budget,
  // TAB_CAPS) - mobil schwebend, am Desktop in den Budget-Kopf gedockt, statt
  // dass ein eigener #split-fab ueber „87,50 €" schwebt. Unveraendert bleibt die (heute nicht erreichte)
  // eigenstaendige Zukunft: <h1>, Beschreibung, Primaerknopf und eigener FAB.
  const head = embedded
    ? `<h2 class="sr-only">${t('splitExpenses.tabLabel')}</h2>`
    : `<header class="panel-head split-topbar">
        <div>
          <h1 class="split-title">${t('splitExpenses.title')}</h1>
          <p class="split-subtitle">${t('splitExpenses.subtitle')}</p>
        </div>
        ${readOnly() ? '' : `<button class="btn btn--primary" id="split-add-expense">
          <i data-lucide="plus" class="icon-md" aria-hidden="true"></i>
          ${t('splitExpenses.addExpense')}
        </button>`}
      </header>`;
  const fab = embedded ? '' : `
      <button class="page-fab" id="split-fab" aria-label="${t('splitExpenses.addExpense')}" data-dock-label="${t('newLabel.splitExpenses')}">
        <i data-lucide="plus" class="icon-xl" aria-hidden="true"></i>
      </button>`;
  setHtml(container, `
    <div class="split-page app-page app-page--split" data-composition="split">
      ${head}
      <div class="split-layout">
        <aside class="split-groups-panel">
          <!-- SCHMAL IST DIE GRUPPENWAHL EINE ZEILE (R16, Critique 2026-10-05):
               Kopf der Liste, Segment und alle Gruppen standen mobil als 284px
               Verwaltung vor der ersten Ausgabe (y=975). Der Knopf nennt die
               aktive Gruppe und klappt die Liste auf; breit ist er
               ausgeblendet und die Liste steht immer (split-expenses.css). -->
          <button type="button" class="split-group-switch" id="split-group-switch"
                  aria-expanded="false" aria-controls="split-groups-body"></button>
          <div class="split-groups-body" id="split-groups-body">
          <!-- Das geteilte Suchfeld (gefuellte Kapsel) statt eines eigenen mit
               sichtbarem Label darueber, das nur den Platzhalter wiederholte
               (Komponenten-Kanon, Critique 2026-09-26 P1). Es steht IM Kopf
               der Liste, die es filtert (.section-toolbar wie das Hauptbuch,
               R14 P1): mobil in seiner Icon-Form statt einer eigenen 48px-Zeile
               vor der ersten Gruppe. -->
          ${groupsPanelHeadHtml(embedded)}
          <!-- Geteilter Umschalter-Baustein des Budget-Moduls statt eigener
               Pillen-Optik, und role="radiogroup" statt role="group": eine
               Einfachauswahl, die ihren Zustand ansagt und über die geteilte
               Verhaltensschicht Pfeiltasten mitbringt (Critique 2026-07-30, P1). -->
          <div class="segmented split-status-filter" id="split-status-filter" role="radiogroup" aria-label="${t('splitExpenses.statusLabel')}">
            ${[['active', 'splitExpenses.statusActive'], ['archived', 'splitExpenses.statusArchived']].map(([id, key]) => {
              const on = state.groupStatus === id;
              return `<button type="button" class="segmented__item${on ? ' is-active' : ''}"
                  role="radio" data-tab-id="${id}" aria-checked="${on}"
                  tabindex="${on ? '0' : '-1'}">${t(key)}</button>`;
            }).join('')}
          </div>
          <!-- Die Summe ueber alle Gruppen (R17, E5) steht bei der Liste, die sie
               zusammenzaehlt - die Kurzzeile oben gehoert der gewaehlten Gruppe. -->
          <p class="split-groups-total" id="split-groups-total" hidden></p>
          <div class="split-groups" id="split-groups"></div>
          </div>
        </aside>
        ${/* KEIN ZWEITES <main> (R20, axe landmark-*): der Ausgleich steht als
             Reiter im Budget, und dessen Seite liegt schon in #main-content der
             Shell - ein <main> darin war ein zweiter Hauptbereich. */ ''}
        ${/* GRUPPENWAHL ZUERST, DIE KENNZAHL BEI IHRER GRUPPE (R21 S7, D9). Die
              Kennzahlen der gewaehlten Gruppe standen ueber der ganzen Seite:
              mobil "Du schuldest 24,14 €" vor der Gruppenwahl, die erst sagt,
              wessen Schuld das ist, und breit eine eigene Kartenreihe ueber
              Gruppenliste und Gruppe (41px Luft unter den Reitern statt 25).
              Jetzt stehen sie in der Spalte der Gruppe, direkt ueber ihrem
              Kopf - die Gruppenliste beginnt oben, wie jede Liste daneben. */ ''}
        <div class="split-main-column">
          <!-- Mobil EINE Zeile statt drei Karten (R14 P1): die Glance-Zeile
               klappt die Kennzahl-Zeile auf (metric-glance.js, budget.css). -->
          <div id="split-glance">${/* Der Kennzahl-Slot steht ab dem ersten Bild in seiner Form (R22, D4). */ ''}${metricGlanceSkeletonHtml()}</div>
          <section class="metric-grid budget-glance-details" id="split-summary">${metricCardsSkeletonHtml(1, { note: false, tag: 'div' })}</section>
          <div class="split-main" id="split-main" aria-busy="true">${renderSkeletonList({ rows: 5, lines: 2 })}</div>
        </div>
      </div>${fab}
    </div>
  `);
  if (window.lucide) lucide.createIcons({ el: _container });
  // Eingebettet verdrahtet budget.js die Menues an seiner Seitenwurzel.
  if (!embedded) installPopoverMenus(_container);
  await loadInitial();
  bindShell();
  renderAll();

  // Erst NACH renderAll(): der Dialog braucht die geladenen Gruppen und
  // Mitglieder, sonst stuende er ohne Beteiligte da.
  if (_pendingPrefill) {
    const prefill = _pendingPrefill;
    _pendingPrefill = null;
    openExpenseModal(null, prefill);
  }
}

async function loadInitial() {
  const calls = [
    api.get('/split-expenses/meta'),
    api.get('/split-expenses/dashboard'),
    api.get('/split-expenses/groups'),
  ];
  if (!isSplitGuest()) calls.push(api.get('/family/members'));
  // Die Kategorien des Budgets (R24, E12). Ein Gast ohne Budget-Recht bekommt
  // sie nicht - dann tragen die Ausgaben ihren Schluessel als Namen, gerechnet
  // wird trotzdem, und das Laden der Seite scheitert nicht daran.
  const budgetMeta = api.get('/budget/meta').catch(() => null);
  const [meta, dashboard, groups, members] = await Promise.all(calls);
  state.budgetCategories = (await budgetMeta)?.data?.expenseCategories ?? [];
  state.meta = meta.data;
  state.dashboard = dashboard.data;
  state.groups = groups.data || [];
  state.members = members?.data || [];
  // Sprungziel von aussen (Dashboard-Kachel „Ausgleich offen"): ?group= oeffnet
  // die Gruppe, in der die genannte Position steht - sonst die erste wie bisher.
  state.activeGroupId = groupFromQuery(window.location.search, state.groups) ?? state.groups[0]?.id ?? null;
  // IMMER, auch ohne Gruppe: der Zustand lebt auf Modulebene und ueberlebt den
  // Seitenwechsel. Ohne aktive Gruppe leert loadGroupData() Ausgaben und
  // Salden - sonst stuende der Saldo der zuletzt gesehenen Gruppe ueber dem
  // Leerzustand, wenn sie inzwischen geloescht, archiviert oder man aus ihr
  // entfernt wurde (die Kurzzeile liest seit R17 aus `state.balances`).
  await loadGroupData();
}

/** Gruppe aus `?group=` - nur eine, die in der geladenen Liste steht. */
function groupFromQuery(search, groups) {
  const id = Number(new URLSearchParams(search || '').get('group'));
  return Number.isInteger(id) && id > 0 && groups.some((g) => g.id === id) ? id : null;
}

function isSplitGuest() {
  return state.user?.access_scope === 'split_guest';
}

async function loadGroups() {
  const res = await api.get(`/split-expenses/groups?status=${state.groupStatus}&q=${encodeURIComponent(state.query)}`);
  state.groups = res.data || [];
  if (!state.activeGroupId || !state.groups.some((g) => g.id === state.activeGroupId)) {
    state.activeGroupId = state.groups[0]?.id || null;
  }
}

// Seitengroesse des Verlaufs. Die Obergrenze des Servers ist 100; beim
// Nachholen einer schon geladenen Tiefe fragt fetchActivity so viel auf einmal.
const ACTIVITY_PAGE = 12;
const ACTIVITY_MAX_PAGE = 100;

// Zaehlt jedes Laden der Gruppendaten. Eine Antwort, die zu einem aelteren
// Stand gehoert (Gruppenwechsel, Neuladen nach einem Storno), wird verworfen
// statt angehaengt - sonst landeten Eintraege der alten Gruppe unter der neuen.
// Gilt fuer beide Listen mit "Mehr laden": Verlauf und Ausgaben (#2108).
let _activityGeneration = 0;

function activityPath(groupId, limit, cursor = null) {
  const params = new URLSearchParams({ limit: String(limit) });
  if (cursor) {
    params.set('before_at', cursor.before_at);
    params.set('before_id', String(cursor.before_id));
  }
  return `/split-expenses/groups/${groupId}/activity?${params}`;
}

const nextActivityCursor = (res) => (res?.pagination?.has_more ? res.pagination.next_cursor ?? null : null);

/** Liegt `item` in der Reihenfolge des Servers (created_at absteigend, id aufsteigend) bei oder hinter `tail`? */
function atOrPast(item, tail) {
  if (item.created_at !== tail.created_at) return item.created_at < tail.created_at;
  return item.id >= tail.id;
}

/**
 * Laedt den Verlauf von vorn. Mit `tail` (dem bisher letzten geladenen
 * Eintrag) wird weitergeblaettert, bis er wieder erreicht ist: ein Neuladen in
 * derselben Gruppe - etwa nach einem Storno weit unten - behaelt die Tiefe, statt
 * auf die erste Seite zurueckzufallen und den Eintrag, an dem gerade gehandelt
 * wurde, aus dem Blick zu nehmen. Doppelte IDs fallen heraus, falls sich
 * zwischen zwei Seiten etwas verschoben hat.
 */
async function fetchActivity(groupId, { depth = ACTIVITY_PAGE, tail = null } = {}) {
  const first = await api.get(activityPath(groupId, Math.min(Math.max(depth, ACTIVITY_PAGE), ACTIVITY_MAX_PAGE)));
  const items = [...(first.data || [])];
  let cursor = nextActivityCursor(first);
  while (tail && cursor && !(items.length && atOrPast(items[items.length - 1], tail))) {
    // eslint-disable-next-line no-await-in-loop
    const more = await api.get(activityPath(groupId, ACTIVITY_MAX_PAGE, cursor));
    const seen = new Set(items.map((item) => item.id));
    items.push(...(more.data || []).filter((item) => !seen.has(item.id)));
    cursor = nextActivityCursor(more);
  }
  return { items, cursor };
}

// Seitengroesse der Ausgabenliste (#2108): der Default der Route. Beim
// Nachholen einer schon geladenen Tiefe fragt fetchExpenses bis zu 100 auf einmal.
const EXPENSE_PAGE = 30;
const EXPENSE_MAX_PAGE = 100;

function expensesPath(groupId, category, limit, cursor = null) {
  const params = new URLSearchParams({ limit: String(limit) });
  if (category) params.set('budget_category', category);
  if (cursor) {
    params.set('before_date', cursor.before_date);
    params.set('before_at', cursor.before_at);
    params.set('before_id', String(cursor.before_id));
  }
  return `/split-expenses/groups/${groupId}/expenses?${params}`;
}

// Ein Cursor statt `offset`: loescht jemand zwischen zwei Seiten eine Ausgabe
// weiter oben, rutschte die naechste ungesehene unter die Zeilenzahl und fehlte.
const nextExpenseCursor = (res) => (res?.pagination?.has_more ? res.pagination.next_cursor ?? null : null);

/** Die Frage, zu der eine geladene Ausgabenliste gehoert: Gruppe und Kategoriefilter. */
const expensesKeyOf = (groupId, category) => `${groupId}|${category || ''}`;

/** Liegt `item` in der Reihenfolge der Route (Datum, Anlage, id - je absteigend) bei oder hinter `tail`? */
function expenseAtOrPast(item, tail) {
  if (item.expense_date !== tail.expense_date) return item.expense_date < tail.expense_date;
  if (item.created_at !== tail.created_at) return item.created_at < tail.created_at;
  return item.id <= tail.id;
}

/**
 * Laedt die Ausgaben von vorn, wie fetchActivity den Verlauf: mit `tail` (der
 * bisher letzten geladenen Ausgabe) wird per Cursor weitergeblaettert, bis ihre Stelle
 * wieder erreicht ist. So faellt die Liste nach Bearbeiten oder Loeschen weit
 * unten nicht auf die ersten 30 zurueck. Doppelte IDs fallen heraus, falls sich
 * zwischen zwei Seiten etwas verschoben hat.
 */
async function fetchExpenses(groupId, category, { depth = EXPENSE_PAGE, tail = null } = {}) {
  const first = await api.get(expensesPath(groupId, category, Math.min(Math.max(depth, EXPENSE_PAGE), EXPENSE_MAX_PAGE)));
  const items = [...(first.data || [])];
  let cursor = nextExpenseCursor(first);
  while (tail && cursor && !(items.length && expenseAtOrPast(items[items.length - 1], tail))) {
    // eslint-disable-next-line no-await-in-loop
    const more = await api.get(expensesPath(groupId, category, EXPENSE_MAX_PAGE, cursor));
    const seen = new Set(items.map((item) => item.id));
    items.push(...(more.data || []).filter((item) => !seen.has(item.id)));
    cursor = nextExpenseCursor(more);
  }
  return { items, cursor };
}

async function loadGroupData() {
  const generation = ++_activityGeneration;
  state.activityLoadingMore = false;
  state.expensesLoadingMore = false;
  if (!state.activeGroupId) {
    state.expenses = [];
    state.expensesCursor = null;
    state.expensesKey = null;
    state.recurring = [];
    state.balances = { balances: [], simplified_debts: [] };
    state.activity = [];
    state.activityCursor = null;
    state.activityGroupId = null;
    return;
  }
  const groupId = state.activeGroupId;
  // Der Kategoriefilter (#1941) gehoert zur Gruppe, in der er gesetzt wurde:
  // eine andere Gruppe beginnt mit allen Ausgaben, statt mit einer leeren
  // Liste unter einer Kategorie, die es dort vielleicht nicht gibt.
  const previousGroup = state.expensesKey ? Number(state.expensesKey.split('|')[0]) : null;
  if (previousGroup != null && previousGroup !== groupId) state.category = '';
  // Dieselbe Gruppe: die geladene Tiefe bleibt. Eine andere: erste Seite.
  const sameGroup = state.activityGroupId === groupId && state.activity.length > 0;
  const activityRequest = sameGroup
    ? { depth: state.activity.length + 1, tail: state.activity[state.activity.length - 1] }
    : {};
  // Ausgaben ebenso (#2108) - aber nur bei derselben Gruppe UND demselben
  // Kategoriefilter; ein Wechsel stellt eine neue Frage und beginnt bei Seite 1.
  const category = state.category;
  const expensesKey = expensesKeyOf(groupId, category);
  const expensesRequest = state.expensesKey === expensesKey && state.expenses.length > 0
    ? { depth: state.expenses.length + 1, tail: state.expenses[state.expenses.length - 1] }
    : {};
  const [expenses, balances, activity, groupMembers, recurring] = await Promise.all([
    fetchExpenses(groupId, category, expensesRequest),
    api.get(`/split-expenses/groups/${groupId}/balances`),
    fetchActivity(groupId, activityRequest),
    api.get(`/split-expenses/groups/${groupId}/members`),
    api.get(`/split-expenses/groups/${groupId}/recurring`),
  ]);
  // Ein spaeteres Laden hat inzwischen begonnen: dessen Stand gilt, nicht dieser.
  if (generation !== _activityGeneration) return;
  state.expenses = expenses.items.filter((entry) => !pendingExpenseDeletes.has(entry.id));
  state.expensesCursor = expenses.cursor;
  state.expensesKey = expensesKey;
  state.balances = balances.data || { balances: [], simplified_debts: [] };
  state.activity = activity.items;
  state.activityCursor = activity.cursor;
  state.activityGroupId = groupId;
  state.groupMembers = groupMembers.data || [];
  state.recurring = recurring?.data || [];
}

/** Ausgaben in der Ruecknahmefrist: lokal weg, am Server noch da (R23, D6). */
const pendingExpenseDeletes = new Set();

/**
 * "Mehr laden" im Verlauf (#1309): die naechste Seite hinter dem Cursor,
 * angehaengt an das Geladene. Ein zweiter Klick, waehrend eine Seite unterwegs
 * ist, tut nichts. Kommt die Antwort erst nach einem Gruppenwechsel oder einem
 * Neuladen an, gehoert sie zu einem Stand, den es nicht mehr gibt, und wird
 * verworfen. Lesen ist keine Handlung - der Knopf steht bei jedem Recht und im
 * Archiv.
 */
async function loadMoreActivity() {
  const cursor = state.activityCursor;
  const groupId = state.activeGroupId;
  if (!cursor || !groupId || state.activityLoadingMore) return;
  const generation = _activityGeneration;
  state.activityLoadingMore = true;
  const hadFocus = typeof document !== 'undefined'
    && document.activeElement?.matches?.('[data-activity-more]');
  renderActivityBox({ keepFocus: hadFocus });
  let res;
  try {
    res = await api.get(activityPath(groupId, ACTIVITY_PAGE, cursor));
  } catch (err) {
    // Der Knopf muss wieder bedienbar sein; die Meldung selbst geht an die
    // globale Fehleranzeige.
    if (generation === _activityGeneration) {
      state.activityLoadingMore = false;
      renderActivityBox({ keepFocus: hadFocus });
    }
    throw err;
  }
  if (generation !== _activityGeneration || groupId !== state.activeGroupId) return;
  state.activityLoadingMore = false;
  const seen = new Set(state.activity.map((item) => item.id));
  state.activity = [...state.activity, ...(res?.data || []).filter((item) => !seen.has(item.id))];
  state.activityCursor = nextActivityCursor(res);
  renderActivityBox({ keepFocus: hadFocus });
}

/**
 * "Mehr laden" unter den Ausgaben (#2108), dasselbe Verhalten wie im Verlauf:
 * die naechste Seite hinter dem Geladenen, ein zweiter Klick waehrend der
 * Ladung tut nichts, eine Antwort nach Gruppenwechsel oder Neuladen wird
 * verworfen. Lesen ist keine Handlung - der Knopf steht bei jedem Recht und
 * im Archiv.
 */
async function loadMoreExpenses() {
  const groupId = state.activeGroupId;
  const key = state.expensesKey;
  const cursor = state.expensesCursor;
  if (!cursor || !groupId || state.expensesLoadingMore || key !== expensesKeyOf(groupId, state.category)) return;
  const generation = _activityGeneration;
  state.expensesLoadingMore = true;
  const hadFocus = typeof document !== 'undefined'
    && document.activeElement?.matches?.('[data-expenses-more]');
  renderExpenseBox({ keepFocus: hadFocus });
  let res;
  try {
    res = await api.get(expensesPath(groupId, state.category, EXPENSE_PAGE, cursor));
  } catch (err) {
    if (generation === _activityGeneration) {
      state.expensesLoadingMore = false;
      renderExpenseBox({ keepFocus: hadFocus });
    }
    throw err;
  }
  if (generation !== _activityGeneration || key !== state.expensesKey) return;
  state.expensesLoadingMore = false;
  const seen = new Set(state.expenses.map((item) => item.id));
  state.expenses = [...state.expenses, ...(res?.data || []).filter((item) => !seen.has(item.id))];
  state.expensesCursor = nextExpenseCursor(res);
  renderExpenseBox({ keepFocus: hadFocus });
}

async function loadMemberCandidates() {
  if (isSplitGuest() || !state.activeGroupId) {
    state.memberCandidates = [];
    return [];
  }
  const res = await api.get(`/split-expenses/groups/${state.activeGroupId}/member-candidates`);
  state.memberCandidates = res.data || [];
  return state.memberCandidates;
}

function bindShell() {
  _container.querySelector('[data-action="add-group"]')?.addEventListener('click', () => openGroupModal());
  _container.querySelector('#split-add-expense')?.addEventListener('click', () => openExpenseModal());
  findPageFab('split-fab')?.addEventListener('click', () => openExpenseModal());
  // 250ms wie vorher: die Suche laedt die Gruppen vom Server neu.
  _groupSearch = wirePageSearch(_container, {
    id: 'split-group-search',
    delay: 250,
    onQuery: async (value) => {
      state.query = value.trim();
      await loadGroups();
      await loadGroupData();
      renderAll();
    },
  });
  _statusTablist = wireTablist(_container.querySelector('#split-status-filter'), {
    activeId: state.groupStatus,
    activeClass: 'is-active',
    mode: 'select',
    onChange: async (id) => {
      state.groupStatus = id;
      state.activeGroupId = null;
      await loadGroups();
      await loadGroupData();
      renderAll();
    },
  });
  // Gleitende Auswahl-Kapsel wie jede Segmentleiste (Kanon, Runde 7 D8).
  const statusBar = _container.querySelector('#split-status-filter');
  if (statusBar) attachSegmentIndicator(statusBar);
  _container.querySelector('#split-group-switch')?.addEventListener('click', () => {
    _groupPickerOpen = !_groupPickerOpen;
    syncGroupSwitch();
  });
  _container.querySelector('#split-groups')?.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-group-id]');
    if (!btn) return;
    state.activeGroupId = Number(btn.dataset.groupId);
    // Gewaehlt ist gewaehlt: die Zeile klappt wieder zu, die Ausgaben stehen.
    _groupPickerOpen = false;
    await loadGroupData();
    renderAll();
  });
}

function isArchivedView() {
  return state.groupStatus === 'archived';
}

function renderAll({ motion = false } = {}) {
  renderStatusFilter();
  renderSummary();
  renderGroups();
  renderMain({ motion });
  if (window.lucide) lucide.createIcons({ el: _container });
}

/**
 * Statusfilter spiegeln + Anlegen-Aktionen im Archiv stilllegen: eine neue
 * Ausgabe würde dort in eine archivierte Gruppe laufen.
 */
function renderStatusFilter() {
  // Zustand über die geteilte Verhaltensschicht spiegeln (sync löst kein
  // onChange aus) statt Klassen und ARIA von Hand nachzuziehen.
  _statusTablist?.sync(state.groupStatus);
  const addExpense = _container.querySelector('#split-add-expense');
  if (addExpense) addExpense.hidden = isArchivedView();
  const fab = findPageFab('split-fab');
  if (fab) fab.hidden = isArchivedView();
  _onAddableChange?.();
}

/**
 * Darf der Budget-Kopf gerade „Ausgabe hinzufuegen" anbieten? Nicht bei
 * `budget: read` und nicht im Archiv - eine neue Ausgabe liefe dort in eine
 * archivierte Gruppe. Dieselbe Regel, die den eigenstaendigen Knopf und FAB
 * oben ausblendet; budget.js fragt sie, statt sie nachzubauen.
 */
export function canAddSplitExpense() {
  return !readOnly() && !isArchivedView();
}

/** Der Anlegen-Weg aus dem Budget-FAB (#fab-new-budget, am Desktop im Kopf). */
export function openNewSplitExpense() {
  if (!canAddSplitExpense()) return;
  openExpenseModal();
}

/**
 * Pure: der eigene Saldo in der GEWAEHLTEN Gruppe, in der Form der
 * Dashboard-Summen (`[{ amount, currency }]`, je Waehrung eine Zeile; leer =
 * ausgeglichen). Quelle sind die Salden der Gruppe (`balances.balances`, eine
 * Zeile je Mitglied und Waehrung, `net` mit Vorzeichen): positiv bekommt man,
 * negativ schuldet man. Wer in der Gruppe keinen Saldo hat, bekommt zwei leere
 * Listen.
 */
function ownGroupBalance(balances = state.balances?.balances ?? [], userId = state.user?.id) {
  const own = userId == null ? [] : balances.filter((row) => Number(row.user_id) === Number(userId));
  const part = (sign) => own
    .filter((row) => Math.sign(Number(row.net_minor ?? Number(row.net) * 100)) === sign)
    .map((row) => ({ amount: String(row.net).replace(/^-/, ''), currency: row.currency }));
  return { owed: part(1), owing: part(-1) };
}

/** Die eigene Summe ueber alle aktiven Gruppen (Dashboard des Servers), in der Form von ownGroupBalance(). */
function allGroupsBalance() {
  const rows = (list) => (list || []).map((row) => ({ amount: String(row.amount).replace(/^-/, ''), currency: row.currency }));
  return { owed: rows(state.dashboard?.total_owed), owing: rows(state.dashboard?.total_owing) };
}

/** Eine Suche, die keine Gruppe trifft: ein Leerzustand an der Liste, nicht "Noch keine Gruppen". */
function isGroupSearchMiss() {
  return Boolean(state.query) && !state.groups.length;
}

/** "24,14 € · 12,00 $" aus Summenzeilen; ohne Zeile die Null in der Standardwaehrung. */
function totalsText(rows) {
  return rows.length ? rows.map((r) => money(r.amount, r.currency)).join(' · ') : money(0, state.meta.default_currency);
}

/**
 * Die Summe ueber ALLE Gruppen steht in der Gruppenwahl (Entscheidung R17,
 * E5), ueber der Liste, deren Gruppen sie zusammenzaehlt. Im Archiv entfaellt
 * sie: die Summen des Servers zaehlen die aktiven Gruppen.
 */
function renderGroupsTotal() {
  const el = _container.querySelector('#split-groups-total');
  if (!el) return;
  const owed = state.dashboard?.total_owed || [];
  const owing = state.dashboard?.total_owing || [];
  el.hidden = isArchivedView() || !state.groups.length;
  // Dieselbe Regel wie die Kennzahl (R22, D9): nur die Richtung, die nicht
  // null ist - "Du bekommst 0,00 €" war eine Aussage ohne Inhalt.
  const parts = [
    owed.length ? `<span class="split-groups-total__part">${t('splitExpenses.youAreOwed')} <strong>${totalsText(owed)}</strong></span>` : '',
    owing.length ? `<span class="split-groups-total__part">${t('splitExpenses.youOwe')} <strong>${totalsText(owing)}</strong></span>` : '',
  ].filter(Boolean);
  setHtml(el, `<span class="split-groups-total__label">${t('splitExpenses.allGroups')}</span>
    ${parts.length ? parts.join('\n    ') : `<span class="split-groups-total__part">${t('splitExpenses.balanced')}</span>`}`);
}

/**
 * EINE SALDO-AUSSAGE, MIT NAMEN (R22 D9, Critique R24 G4-Aufteilung-P2-6).
 * Mobil stand "Du schuldest" dreimal untereinander: die Kennzahl "Du schuldest
 * 24,14 €", darunter die Salden-Zeile "Du schuldest Alex Johnson 24,14 €".
 * Steht in der Gruppe genau EINE Schuld und betrifft sie mich, ist sie die
 * Kennzahl - mit dem Namen des Gegenuebers -, und die Salden-Liste laesst sie
 * weg. Erst ab zwei Gegenuebern (oder bei einer Schuld zwischen anderen)
 * fuehrt die Liste. Im Archiv-Leerzustand und ohne Gruppe nie.
 */
function foldedDebt() {
  if (!state.activeGroupId || isGroupSearchMiss()) return null;
  const debts = state.balances?.simplified_debts || [];
  if (debts.length !== 1) return null;
  const me = Number(state.user?.id);
  const [debt] = debts;
  return Number(debt.from_user_id) === me || Number(debt.to_user_id) === me ? debt : null;
}

function renderSummary() {
  const summary = _container.querySelector('#split-summary');
  // DIE KURZZEILE GEHOERT DER GEWAEHLTEN GRUPPE (Entscheidung R17, E5). Bis R17
  // stand hier die Summe ueber alle Gruppen - "Du schuldest 196,14 €" direkt
  // ueber dem Saldo der Gruppe "Linda schuldet Alex 24,14 €": zwei Zahlen fuer
  // scheinbar dieselbe Frage. Die Summe aller Gruppen steht jetzt in der
  // Gruppenwahl (renderGroupsTotal()).
  // OHNE GEWAEHLTE GRUPPE (Suche ohne Treffer, Critique R23 P1) gilt die Summe
  // ueber ALLE aktiven Gruppen - sonst stand hier "Ausgeglichen 0,00 €", eine
  // Aussage ueber eine Gruppe, die es in diesem Bild nicht gibt.
  const { owed, owing } = isGroupSearchMiss() && !isArchivedView() ? allGroupsBalance() : ownGroupBalance();
  renderGroupsTotal();
  // Geteilte Kennzahlkarte des Budget-Moduls (budget.css). Die frühere eigene
  // .split-summary-card war die dritte von fünf Bauarten im selben Modul
  // (Critique 2026-07-30, P0).
  // Rolle `total`: die Richtung steht im Label („Du bekommst" / „Du schuldest"),
  // nicht im Vorzeichen - deshalb der Ton explizit statt aus der Zahl.
  // Die Zahl der Gruppen steht auch am Kopf der Liste, die sie zaehlt - mobil
  // ist sie dort die einzige (split-expenses.css, R10 L11).
  const count = _container.querySelector('#split-group-count');
  if (count) count.textContent = String(state.groups.length);
  const owedText = totalsText(owed);
  const owingText = totalsText(owing);
  // DER BEREICH STEHT IM LABEL (Critique R19, P1 Desktop-Komposition): die
  // Karten nennen ihre Gruppe, die Gruppenzahl steht am Kopf der Liste, die sie
  // zaehlt (`#split-group-count`). Die Kurzzeile (nur schmal, direkt ueber der
  // Gruppenwahl, die den Namen traegt) nennt sie nicht (R19).
  const group = state.groups.find((g) => g.id === state.activeGroupId)?.name;
  const inGroup = (plain, scoped) => (group ? t(scoped, { group }) : t(plain));
  /* EINE SALDO-AUSSAGE (R22, D9). Bis dahin standen beide Richtungen da, und
   * gross die erste: mobil "Du bekommst 0,00 €" in Display-Groesse, klein
   * daneben "Du schuldest 24,14 €", am Desktop zwei 210px-Karten, eine davon
   * eine Null - drei Saetze fuer eine Antwort. Die Kennzahl ist jetzt die
   * Richtung, die nicht null ist; ohne Saldo "Ausgeglichen". Nur wer in einer
   * Gruppe in zwei Waehrungen in beide Richtungen steht, sieht beide. */
  const both = owed.length > 0 && owing.length > 0;
  const folded = both ? null : foldedDebt();
  const lead = folded
    ? {
      text: debtSentence(folded),
      value: money(folded.amount, folded.currency),
      tone: Number(folded.to_user_id) === Number(state.user?.id) ? 'positive' : 'neutral',
    }
    : owing.length && !owed.length
    ? { label: 'splitExpenses.youOwe', scoped: 'splitExpenses.youOweInGroup', value: owingText, tone: 'neutral' }
    : owed.length
      ? { label: 'splitExpenses.youAreOwed', scoped: 'splitExpenses.youAreOwedInGroup', value: owedText, tone: 'positive' }
      : { label: 'splitExpenses.balanced', scoped: 'splitExpenses.balancedInGroup', value: owedText, tone: 'neutral' };
  const glance = _container.querySelector('#split-glance');
  if (glance) {
    const expanded = summary?.classList?.contains('is-expanded') ?? false;
    // Eine Zahl: die Kurzzeile ohne Aufklapper (metric-glance.js) - die Karte
    // darunter wiederholte nur dieselbe Zahl mit dem Gruppennamen.
    setHtml(glance, metricGlanceHtml({
      ...(both ? { id: 'split-glance-more', controls: 'split-summary', expanded } : {}),
      label: lead.text ?? t(lead.label),
      value: lead.value,
      tone: lead.tone,
      // Eine offene Schuld in der Gruppe ist Alltag, kein Alarm (Critique R21,
      // D8): Textfarbe. „Du bekommst" darf gruen bleiben wie eine Einnahme.
      flows: both ? [{ label: t('splitExpenses.youOwe'), amount: owingText, tone: '' }] : [],
    }));
    if (both) wireMetricGlance(glance, 'split-glance-more');
  }
  // DER TON GILT DEM BETRAG, NICHT DER KARTE (Critique 2026-10-05, R16): Null
  // ist weder Gewinn noch Schuld.
  const card = (label, value, tone) => `
    <div class="metric-card${tone === 'positive' ? ' metric-card--positive' : ''}">
      <div class="metric-card__label">${esc(label)}</div>
      <div class="metric-card__value">${value}</div>
    </div>`;
  setHtml(summary, both
    ? card(inGroup('splitExpenses.youAreOwed', 'splitExpenses.youAreOwedInGroup'), owedText, 'positive')
      + card(inGroup('splitExpenses.youOwe', 'splitExpenses.youOweInGroup'), owingText, 'neutral')
    : card(lead.text ?? inGroup(lead.label, lead.scoped), lead.value, lead.tone));
}

/**
 * Die eine Zeile der Gruppenwahl (schmal): aktive Gruppe mit Typ und
 * Mitgliederzahl, dahinter der Aufklapp-Pfeil. Ohne aktive Gruppe (leere
 * Liste, leeres Archiv, Suche ohne Treffer) steht die Liste offen - sonst
 * laegen Leerzustand, Suche und „+" hinter einem Knopf ohne Namen.
 */
function syncGroupSwitch() {
  const panel = _container.querySelector('.split-groups-panel');
  const btn = _container.querySelector('#split-group-switch');
  // `classList` mitgeprueft, wie beim Aufklapper der Kennzahlen: ein Aufrufer
  // ohne gebaute Seite (Storno aus dem Verlauf im Test) hat hier nichts zu tun.
  if (!panel?.classList || !btn) return;
  const group = state.groups.find((g) => g.id === state.activeGroupId);
  const open = _groupPickerOpen || !group;
  panel.classList.toggle('split-groups-panel--open', open);
  btn.setAttribute('aria-expanded', String(open));
  setHtml(btn, `
    <span class="split-group__avatar budget-tile"><i data-lucide="${group ? groupIcon(group.type) : 'users-round'}" aria-hidden="true"></i></span>
    <span class="split-group__body">
      <span class="sr-only">${t('splitExpenses.groups')}: </span>
      <span class="split-group__name">${group ? esc(group.name) : t('splitExpenses.groups')}</span>
      ${group ? `<span class="split-group__meta">${groupTypeLabel(group) ? `${esc(groupTypeLabel(group))} · ` : ''}${group.member_count} ${t('splitExpenses.members')}${isArchivedView() ? ` · ${t('splitExpenses.statusArchived')}` : ''}</span>` : ''}
    </span>
    <i data-lucide="chevron-down" class="icon-md split-group-switch__chevron" aria-hidden="true"></i>`);
  if (window.lucide) lucide.createIcons({ el: btn });
}

function renderGroups() {
  syncGroupSwitch();
  const el = _container.querySelector('#split-groups');
  if (isGroupSearchMiss()) {
    setHtml(el, searchEmptyHTML({ query: state.query, className: 'split-empty-inline', resetAttrs: { 'data-split-reset-search': '' } }));
    el.querySelector('[data-split-reset-search]')?.addEventListener('click', async () => {
      _groupSearch?.clear();
      state.query = '';
      await loadGroups();
      await loadGroupData();
      renderAll();
      _groupSearch?.input?.focus();
    });
    return;
  }
  if (!state.groups.length) {
    setHtml(el, isArchivedView()
      ? emptyStateHTML({
        className: 'split-empty-inline',
        icon: 'archive',
        title: t('splitExpenses.emptyArchivedTitle'),
      })
      : emptyStateHTML({
        className: 'split-empty-inline',
        icon: 'receipt-text',
        title: t('splitExpenses.emptyGroupsTitle'),
        // „Erstelle eine Gruppe" beschreibt bei `budget: read` einen Weg, den es
        // nicht gibt - der Titel allein ist die Auskunft.
        description: readOnly() ? '' : t('splitExpenses.emptyGroupsText'),
      }));
    return;
  }
  setHtml(el, state.groups.map((group) => `
    <button class="split-group ${group.id === state.activeGroupId ? 'split-group--active' : ''}" type="button" data-group-id="${group.id}">
      <span class="split-group__avatar budget-tile"><i data-lucide="${groupIcon(group.type)}" aria-hidden="true"></i></span>
      <span class="split-group__body">
        <span class="split-group__name">${esc(group.name)}</span>
        <span class="split-group__meta">${groupTypeLabel(group) ? `${esc(groupTypeLabel(group))} · ` : ''}${group.member_count} ${t('splitExpenses.members')}</span>
      </span>
    </button>
  `).join(''));
}

/**
 * EIN Werkzeug-Menue fuer die Gruppe (Critique 2026-09-25, Muster „one tools
 * menu" aus den Dokumenten und der Buchungsliste). Hier standen drei Icon-
 * Knoepfe (Bearbeiten, Archivieren, Loeschen) und zwei Textknoepfe
 * (Ausgleichen, Mitglied hinzufuegen) - bei 1440px zwei Zeilen im Gruppenkopf.
 * Sichtbar bleibt die haeufige Handlung (Ausgleichen); der Rest traegt im Menue
 * sein Label, Loeschen im Gefahrenton und als letzter Eintrag hinter einem
 * Trenner. Die ids bleiben, die Verdrahtung in renderMain() haengt an ihnen.
 * Ein Gast bekommt nur „Ausgleichen": die vier Eintraege hier verwalten die
 * Gruppe, und das darf er nicht - dann faellt das Menue ganz.
 */
/** Ein Ausloeser des Gruppen-Werkzeugmenues; das Menue selbst baut groupToolsMenuHtml(). */
function groupToolsTriggerHtml() {
  if (isSplitGuest()) return '';
  const label = t('common.moreActions');
  return `
    <button type="button" class="btn btn--secondary btn--icon split-group-tools popover-menu__trigger"
            popovertarget="split-group-tools-menu" aria-haspopup="menu" aria-expanded="false"
            aria-label="${esc(label)}" title="${esc(label)}">
      <i data-lucide="ellipsis" class="icon-md" aria-hidden="true"></i>
    </button>`;
}

function groupToolsMenuHtml() {
  if (isSplitGuest()) return '';
  const label = t('common.moreActions');
  const item = (id, icon, text, danger = false) => `
      <button type="button" role="menuitem" class="popover-menu__item${danger ? ' popover-menu__item--danger' : ''}" id="${id}">
        <i data-lucide="${icon}" class="icon-md" aria-hidden="true"></i><span>${esc(text)}</span>
      </button>`;
  return `${groupToolsTriggerHtml()}
    <div class="popover-menu split-group-tools-menu" id="split-group-tools-menu" popover role="menu" aria-label="${esc(label)}">
      ${item('split-invite', 'user-plus', t('splitExpenses.addMember'))}
      ${item('split-edit-group', 'pencil', t('splitExpenses.editGroup'))}
      ${item('split-archive-group', 'archive', t('splitExpenses.archiveGroup'))}
      <div class="popover-menu__separator" role="separator"></div>
      ${item('split-delete-group', 'trash-2', t('splitExpenses.deleteGroup'), true)}
    </div>`;
}

/* Ausgaben und Serien der Gruppe tragen `data-row-key`: die Zeile hat je nach
 * Recht zwei Formen (`data-expense-id` bearbeitet, `data-expense-view` liest),
 * die Bewegung erkennt sie an EINEM Attribut wieder. */
const SPLIT_ROW = '[data-row-key]';

/* `motion: true` setzt, wer die DATEN der Gruppe geaendert hat (Ausgabe oder
 * Serie angelegt, gespeichert, geloescht): die neue Zeile zieht auf, und was
 * dadurch die Stelle wechselt, gleitet (utils/list-motion.js). Traeger ist
 * `#split-main` - die Abschnitte darin baut jedes Zeichnen neu. Gruppen- und
 * Archivwechsel zeichnen ohne Bewegung neu: dort wechselt die Frage. */
function renderMain({ motion = false } = {}) {
  const main = _container.querySelector('#split-main');
  if (motion) {
    redrawList(main, () => drawMain(main), { selector: SPLIT_ROW, keyAttr: 'data-row-key' });
    return;
  }
  drawMain(main);
  stagger(main.querySelectorAll('.split-expense, .split-debt, .split-activity-item'), { host: main });
}

/** Klappt die Zeile `key` aus, bevor die Gruppe ohne sie neu gezeichnet wird. */
function collapseSplitRow(key) {
  return collapseRow(_container?.querySelector(`#split-main [data-row-key="${key}"]`) ?? null);
}

function drawMain(main) {
  main.removeAttribute('aria-busy');
  const group = state.groups.find((g) => g.id === state.activeGroupId);
  // Die Suche ohne Treffer steht EINMAL, an der Liste, die gesucht wurde
  // (renderGroups) - hier stand derselbe Satz "Noch keine Ausgabengruppen"
  // ein zweites Mal, und er war falsch: es gibt Gruppen, nur keine Treffer.
  if (!group && isGroupSearchMiss()) {
    setHtml(main, '');
    return;
  }
  if (!group) {
    setHtml(main, isArchivedView()
      ? emptyStateHTML({
        className: 'split-main-empty',
        icon: 'archive',
        title: t('splitExpenses.emptyArchivedTitle'),
      })
      : emptyStateHTML({
        className: 'split-main-empty',
        icon: 'users-round',
        title: t('splitExpenses.emptyGroupsTitle'),
        description: readOnly() ? '' : t('splitExpenses.emptyGroupsText'),
      }));
    return;
  }
  // Archiv-Ansicht: Salden, Ausgaben und Verlauf bleiben lesbar, alle
  // schreibenden Aktionen weichen dem Wiederherstellen (#574).
  const archived = isArchivedView();
  const ro = readOnly();
  const GroupTag = _embedded ? 'h3' : 'h2';
  const SectionTag = _embedded ? 'h4' : 'h3';
  // "AUSGLEICHEN" STEHT IN DER SALDEN-ZEILE (Entscheidung R17, E5): es ist die
  // Handlung an den Salden, und im Gruppenkopf kostete es mobil eine eigene
  // 60px-Zeile vor der ersten Ausgabe (y=502 bei 390x844). Schmal traegt der
  // Gruppenkopf dann nichts Sichtbares mehr - Name und Typ stehen in der
  // Gruppenwahl darueber - und tritt ganz zurueck (`--tools-only`,
  // split-expenses.css); das Werkzeugmenue bekommt dort einen zweiten
  // Ausloeser in der Salden-Zeile (EIN Menue, zwei Ausloeser, je Breite steht
  // einer - popover-menu.js richtet sich am sichtbaren aus).
  const canAct = !ro && !archived;
  const toolsOnly = canAct;
  const balanceActions = canAct ? `
          <div class="split-section-actions">
            <button class="btn btn--secondary btn--sm" id="split-settle">
              <i data-lucide="hand-coins" class="icon-md" aria-hidden="true"></i>
              ${t('splitExpenses.settle')}
            </button>
            ${groupToolsTriggerHtml()}
          </div>` : '';
  setHtml(main, `
    <section class="split-group-header${toolsOnly ? ' split-group-header--tools-only' : ''}">
      <div class="split-group-header__text">
        <${GroupTag} class="split-group-name">${esc(group.name)}</${GroupTag}>
        ${groupTypeLabel(group) ? `<p class="split-group-type">${esc(groupTypeLabel(group))}</p>` : ''}
        ${archived ? `<p class="split-archived-badge"><i data-lucide="archive" class="icon-md" aria-hidden="true"></i>${t('splitExpenses.statusArchived')}</p>` : ''}
        <p class="split-group-desc">${esc(group.description || t('splitExpenses.groupDefaultDescription'))}</p>
        ${ro ? groupMetaHtml(group) : ''}
      </div>
      ${/* Bei `budget: read` faellt die ganze Leiste: Bearbeiten, Archivieren,
          * Loeschen, Abrechnen, Mitglied einladen und im Archiv Wiederherstellen
          * schreiben alle. Salden, Ausgaben und Verlauf darunter bleiben. */ ''}
      ${ro ? '' : `<div class="split-header-actions">
        ${archived ? `
        <button class="btn btn--secondary" id="split-restore-group" ${isSplitGuest() ? 'hidden' : ''}>
          <i data-lucide="archive-restore" class="icon-md" aria-hidden="true"></i>
          ${t('splitExpenses.restoreGroup')}
        </button>` : groupToolsMenuHtml()}
      </div>`}
    </section>
    ${/* ABSCHNITTSTITEL AUF DER BUEHNE, ZEILEN IM TRAEGER (R16 Schritt 2b,
        * Reiter-Skelett des Budgets). Hier standen drei Karten mit dem Titel
        * als 17px-Kartentitel IN der Flaeche und den Zeilen in deren Polster -
        * die vierte Titel- und fuenfte Listenform des Moduls. Jetzt wie
        * "Transaktionen" in der Uebersicht: `.u-section-title` ueber einem
        * `.row-carrier`. Die Stufe (h4 eingebettet) bleibt die der Gliederung
        * Budget > Aufteilung > Gruppe > Abschnitt; die Rolle kommt von der
        * Klasse. Ein leerer Abschnitt traegt keine Flaeche. */ ''}
    <div class="split-content-grid">
      ${/* DER ABSCHNITT "SALDEN" ENTFAELLT, WENN DIE EINZIGE SCHULD IN DER
          * KENNZAHL STEHT (Ulas 29.10., S10-F6). Uebrig blieb sonst ein Titel
          * ueber nichts. Die Handlung an der Schuld ("Ausgleichen", mobil dazu
          * der zweite Ausloeser der Gruppenwerkzeuge) bleibt - als Werkzeugzeile
          * ohne Titel direkt unter der Kennzahl; der Name des Bereichs steht fuer
          * Screenreader am Abschnitt. Ohne Handlung (Nur-lesen, Archiv) faellt
          * der Abschnitt ganz weg. */ ''}
      ${foldedDebt() ? (balanceActions ? `
      <section class="split-section split-section--balances split-section--folded" aria-label="${esc(t('splitExpenses.balances'))}">
        <div class="split-section-head">${balanceActions}
        </div>
      </section>` : '') : `
      <section class="split-section split-section--balances">
        <div class="split-section-head">
          <div class="split-section-head__lead">
            <${SectionTag} class="split-section-title u-section-title">${t('splitExpenses.balances')}</${SectionTag}>
            <span>${t('splitExpenses.simplified')}</span>
          </div>${balanceActions}
        </div>
        <div id="split-balances">${renderBalances()}</div>
      </section>`}
      <section class="split-section split-section--expenses">
        <div class="split-section-head">
          <${SectionTag} class="split-section-title u-section-title">${t('splitExpenses.recentExpenses')}</${SectionTag}>
          ${renderCategoryFilter()}
        </div>
        <div id="split-expense-list">${renderExpenses(archived || ro)}</div>
      </section>
      ${renderTotalsSections(SectionTag)}
      <section class="split-section">
        <div class="split-section-head">
          <${SectionTag} class="split-section-title u-section-title">${t('budget.recurringLabel')}</${SectionTag}>
          ${canAct ? `<button type="button" class="btn btn--secondary btn--sm split-recurring-add" data-recurring-add>
            <i data-lucide="plus" class="icon-md" aria-hidden="true"></i>${esc(t('splitExpenses.recurring.add'))}
          </button>` : ''}
        </div>
        <div id="split-recurring-list">${renderRecurring(archived || ro)}</div>
      </section>
      <section class="split-section">
        <div class="split-section-head">
          <${SectionTag} class="split-section-title u-section-title">${t('splitExpenses.activity')}</${SectionTag}>
        </div>
        <div class="split-activity">${renderActivity()}</div>
      </section>
    </div>
  `);
  main.querySelector('#split-restore-group')?.addEventListener('click', () => restoreGroup(group.id));
  main.querySelector('#split-edit-group')?.addEventListener('click', () => openGroupModal(group));
  main.querySelector('#split-archive-group')?.addEventListener('click', () => archiveGroup(group.id));
  main.querySelector('#split-delete-group')?.addEventListener('click', () => deleteGroup(group.id));
  main.querySelector('#split-settle')?.addEventListener('click', () => openSettlementModal());
  const settleButton = main.querySelector('#split-settle');
  // Gefiltert kann die Liste leer sein, obwohl die Gruppe Ausgaben hat.
  if (settleButton) settleButton.disabled = state.expenses.length === 0 && !state.category;
  main.querySelector('#split-category-filter')?.addEventListener('click', (e) => openCategoryFilter(e.currentTarget));
  main.querySelector('#split-invite')?.addEventListener('click', () => openMemberModal());
  main.querySelector('.split-activity')?.addEventListener('click', onActivityClick);
  main.querySelector('#split-expense-list')?.addEventListener('click', onExpenseListClick);
  main.querySelector('[data-recurring-add]')?.addEventListener('click', () => openRecurringModal());
  main.querySelector('#split-recurring-list')?.addEventListener('click', onRecurringClick);
}

/**
 * Delegierter Klick in der Ausgabenliste: "Mehr laden" liest (#2108), eine
 * Zeile oeffnet ihre Ausgabe.
 */
function onExpenseListClick(e) {
  if (e.target.closest('[data-expenses-more]')) return loadMoreExpenses();
  // Zwei Wege, je nach Markup: `data-expense-view` liest (Archiv und
  // `budget: read`), `data-expense-id` bearbeitet. Den zweiten gibt es bei
  // `read` gar nicht - und fragt openExpenseModal() trotzdem, verzweigt es
  // selbst in die Leseansicht.
  const btn = e.target.closest('[data-expense-view], [data-expense-id]');
  if (!btn) return undefined;
  const expense = state.expenses.find((item) => item.id === Number(btn.dataset.expenseView ?? btn.dataset.expenseId));
  if (!expense) return undefined;
  openExpenseReadView(expense, { editable: !btn.dataset.expenseView && !readOnly() && !isArchivedView() });
  return undefined;
}

// So viele Namen stehen in der Kopfzeile einer Gruppe, der Rest als „+N".
const GROUP_META_NAMES = 5;

/**
 * Die Angaben des Gruppen-Dialogs, die der Kopf sonst nicht traegt (#1265 P7):
 * Standardwaehrung, Standardaufteilung samt Vorbelegung je Person, und die
 * Mitglieder. Nur bei `budget: read` - mit Schreibrecht fuehrt der Stift in den
 * Dialog, der sie zeigt; bei `read` gibt es den Stift nicht, und die Werte
 * stehen dort, wo der Blick ohnehin landet, statt hinter einem neuen Knopf.
 *
 * EINE Zeile, nicht endlos: bis GROUP_META_NAMES Namen, danach „+N" ueber einen
 * Plural-Schluessel. Alles geht als Text durch esc() - Namen und Waehrung sind
 * Daten, und t() liefert kein Markup.
 */
function groupMetaHtml(group) {
  const members = state.groupMembers || [];
  const method = group.default_split_method || 'equal';
  const values = defaultSplitValues(group);
  // Zahlformat der Haushalts-Einstellung, nicht der Sprache (#521, getNumberFormat).
  // Der Dialog fuehrt die Vorbelegung als rohe Zahl mit hoechstens zwei
  // Nachkommastellen, die Einheit steht dort in der Methode („Prozent"). Hier,
  // ohne das Feld daneben, traegt die Zahl ihre Einheit selbst - und zwar so, wie
  // die Region sie schreibt: Stellung und Abstand des Prozentzeichens kommen aus
  // Intl („60%" in en-US, „60 %" in de-DE), nicht aus einem festen Literal.
  const percent = getNumberFormat({ style: 'percent', maximumFractionDigits: 2 });
  const number = getNumberFormat({ maximumFractionDigits: 2 });
  const preset = (value) => (method === 'percentage'
    ? percent.format(Number(value) / 100)
    : number.format(Number(value)));
  const presets = members
    .map((m) => [m.display_name, values[m.user_id ?? m.id]])
    .filter(([, value]) => value != null && value !== '')
    .map(([name, value]) => `${name} ${preset(value)}`);
  const methodLabel = t(`splitExpenses.split${method.charAt(0).toUpperCase()}${method.slice(1)}`);
  const names = members.slice(0, GROUP_META_NAMES)
    .map((m) => (m.role === 'guest' ? `${m.display_name} (${t('splitExpenses.roleGuest')})` : m.display_name));
  const rest = members.length - names.length;
  if (rest > 0) names.push(t('splitExpenses.moreMembers', { count: rest }));
  const parts = [
    group.default_currency ? `${t('splitExpenses.currency')}: ${group.default_currency}` : '',
    `${t('splitExpenses.defaultSplit')}: ${presets.length ? `${methodLabel} - ${presets.join(', ')}` : methodLabel}`,
    names.length ? `${t('splitExpenses.members')}: ${names.join(', ')}` : '',
  ].filter(Boolean);
  return `<p class="split-group-meta">${esc(parts.join(' · '))}</p>`;
}

/**
 * EIN SALDO AUS SICHT DESSEN, DER LIEST (Re-Critique 2026-10-17, A4 P3). Hier
 * stand fuer jede Zeile "<Name> schuldet <Name>", auch fuer die eigene: Linda
 * las "Linda Johnson schuldet Alex Johnson". Wer selbst beteiligt ist, liest
 * "Du schuldest Alex Johnson" bzw. "Alex Johnson schuldet dir"; zwischen zwei
 * anderen bleibt der Satz mit beiden Namen - als EIN Schluessel mit beiden
 * Platzhaltern, damit jede Sprache ihre Wortstellung hat (vorher Name + Verb
 * + Name zusammengesetzt).
 */
export function debtSentence(debt, userId = state.user?.id) {
  const me = userId == null ? null : Number(userId);
  if (me != null && Number(debt.from_user_id) === me) return t('splitExpenses.debtYouOwe', { name: debt.to_name });
  if (me != null && Number(debt.to_user_id) === me) return t('splitExpenses.debtOwesYou', { name: debt.from_name });
  return t('splitExpenses.debtOwes', { from: debt.from_name, to: debt.to_name });
}

/**
 * DIE KATEGORIE IST EINE BUDGET-KATEGORIE (R24, E12; Critique
 * G4-Aufteilung-P2-6). Bis R24 fuehrte die Aufteilung zwoelf eigene Schluessel
 * mit Icon-Mulden neben den Budget-Kategorien mit Farbpunkt - wer im selben
 * Modul vom Eintrag zur Ausgabe wechselte, las zwei Codierungen fuer dieselbe
 * Frage. Jetzt derselbe Katalog (budget_categories, Typ Ausgabe), derselbe Name
 * (budgetCategoryLabel) und derselbe Punkt in der Farbe der Katalogstelle
 * (categoryPaint, budget-category-colors.js) wie im Journal. `null` ist "ohne
 * Kategorie".
 */
function categoryLabel(key) {
  if (!key || key === 'none') return t('splitExpenses.noCategory');
  const known = state.budgetCategories.find((c) => c.key === key);
  return budgetCategoryLabel(key, known?.name ?? key, t);
}

/** Der Punkt einer Kategorie: Farbe (und Zweitkanal) wie im Budget-Journal, ohne Kategorie neutral. */
function categoryDotHtml(key) {
  const { color, texture } = key
    ? categoryPaint(null, key, state.budgetCategories.map((c) => c.key))
    : { color: null, texture: null };
  const paint = color ? ` style="--entry-color:${color}"${texture ? ` data-texture="${texture}"` : ''}` : '';
  return `<span class="budget-entry__indicator budget-entry__indicator--expenses split-expense__dot" aria-hidden="true"${paint}></span>`;
}

/** Die Wahl der Kategorie in den Dialogen: "Ohne Kategorie" und die Ausgaben-Kategorien des Budgets. */
function categoryOptions(selected = null) {
  const value = selected || '';
  const list = state.budgetCategories.map((c) => c.key);
  const keys = value && !list.includes(value) ? [...list, value] : list;
  return `<option value=""${value ? '' : ' selected'}>${esc(t('splitExpenses.noCategory'))}</option>`
    + keys.map((key) => `<option value="${esc(key)}"${key === value ? ' selected' : ''}>${esc(categoryLabel(key))}</option>`).join('');
}

/**
 * Die Kategorien, die in der Gruppe vorkommen (#1941), groesste Summe zuerst;
 * 'none' fuer Ausgaben ohne. Quelle sind die Summen des Servers, nicht die
 * geladene Seite der Liste - eine Kategorie weiter unten fehlte sonst im Filter.
 */
function groupCategories() {
  const keys = (state.balances?.budget_category_totals || []).map((row) => row.budget_category || 'none');
  return [...new Set(keys)];
}

/**
 * DER KATEGORIEFILTER IST EIN FILTERKNOPF IM ABSCHNITTSKOPF (Critique R24
 * G4-Aufteilung-P2-6). Hier stand ein natives `<select>` "Alle Kategorien"
 * neben dem Titel - die einzige Auswahlliste als Filter im Modul, waehrend Abos
 * und Transaktionen den Knopf mit Zaehler fuehren. Jetzt derselbe Knopf
 * (filterButtonHtml), dahinter die Kategorien als Chips im Filterblatt bzw. am
 * Desktop als Popover. Angeboten wird, was in der Gruppe vorkommt; mit nur
 * einer Kategorie gibt es nichts zu filtern, und der Knopf entfaellt - ausser
 * ein Filter steht schon. Lesen ist keine Handlung: der Knopf steht bei jedem
 * Recht und im Archiv.
 */
function renderCategoryFilter() {
  const present = groupCategories();
  const active = state.category || '';
  if (present.length < 2 && !active) return '';
  return filterButtonHtml({ id: 'split-category-filter', count: active ? 1 : 0, className: 'split-category-filter' });
}

function openCategoryFilter(button) {
  const present = groupCategories();
  const active = state.category || '';
  const offered = active && !present.includes(active) ? [...present, active] : present;
  const chips = [
    filterChipHtml({ filter: 'split-category', value: '', label: t('splitExpenses.allCategories'), active: !active }),
    ...offered.map((key) => filterChipHtml({ filter: 'split-category', value: key, label: categoryLabel(key), active: key === active })),
  ].join('');
  const panel = openFilterSheet({
    groups: [{ heading: t('splitExpenses.categoryLabel'), html: `<div class="filter-panel__chips" role="group" aria-label="${esc(t('splitExpenses.categoryFilter'))}">${chips}</div>` }],
    anchor: () => _container?.querySelector('#split-category-filter'),
    onReset: () => setCategoryFilter(''),
  });
  panel?.addEventListener('click', async (e) => {
    const chip = e.target.closest('.filter-chip[data-filter="split-category"]');
    if (!chip) return;
    const value = chip.dataset.value || '';
    panel.querySelectorAll('.filter-chip[data-filter="split-category"]').forEach((el) => {
      const on = el === chip;
      el.classList.toggle('filter-chip--active', on);
      el.setAttribute('aria-pressed', String(on));
    });
    await setCategoryFilter(value);
  });
  return panel;
}

/**
 * Setzt den Kategoriefilter und laedt die Liste dazu vom Server - gefiltert
 * wird dort, das Ergebnis ist also vollstaendig, wie weit die Liste auch
 * geladen war. Neu gezeichnet werden die Liste und der Zaehler am Knopf; der
 * Knopf selbst bleibt (Fokus, offenes Popover).
 */
async function setCategoryFilter(category) {
  const known = category === 'none' || state.budgetCategories.some((c) => c.key === category)
    || groupCategories().includes(category);
  state.category = category && known ? category : '';
  await loadGroupData();
  renderExpenseBox();
  const button = _container?.querySelector('#split-category-filter');
  if (button) syncFilterButton(button, state.category ? 1 : 0);
}

/**
 * WAS JEDE PERSON BEZAHLT HAT, DARUNTER IHR EIGENER ANTEIL (#1888). Der Betrag
 * rechts ist das Ausgelegte - die Zahl, auf die man waehrend einer Reise
 * schaut; der Anteil steht als Metazeile darunter und nennt sich selbst. Je
 * Person und Waehrung eine Zeile, ohne Umrechnung, ueber alle Ausgaben der
 * Gruppe (der Server zaehlt, nicht die geladene Seite).
 */
function renderMemberTotals() {
  const rows = state.balances?.member_totals || [];
  if (!rows.length) return '';
  return `<div class="row-carrier">${rows.map((row) => `
    <div class="split-expense split-total">
      <div class="split-expense__body">
        <strong>${esc(row.display_name || '')}</strong>
        <span>${esc(t('splitExpenses.ownShare', { amount: money(row.share, row.currency) }))}</span>
      </div>
      <div class="split-expense__amount"><span class="sr-only">${esc(t('splitExpenses.paidLabel'))} </span>${esc(money(row.paid, row.currency))}</div>
    </div>`).join('')}</div>`;
}

/** Wohin das Geld ging (#1941): je Budget-Kategorie und Waehrung die Summe, die groesste zuerst (R24, E12). */
function renderCategoryTotals() {
  const rows = state.balances?.budget_category_totals || [];
  if (!rows.length) return '';
  return `<div class="row-carrier">${rows.map((row) => `
    <div class="split-expense split-total">
      ${categoryDotHtml(row.budget_category)}
      <div class="split-expense__body"><strong>${esc(categoryLabel(row.budget_category))}</strong></div>
      <div class="split-expense__amount">${esc(money(row.total, row.currency))}</div>
    </div>`).join('')}</div>`;
}

/**
 * Die beiden Summen stehen unter den Salden, in derselben Spalte (#1888,
 * #1941): Salden sagen, wer wem schuldet, die Summen, wie es dazu kam. Im
 * DOM folgen sie der Ausgabenliste: zweispaltig setzt das Raster die Liste
 * links fest, und die rechte Spalte fuellt sich in DOM-Folge (Salden, Summen,
 * Wiederkehrend, Verlauf); gestapelt bleibt die erste Ausgabe direkt unter den
 * Salden, wie seit R17 (sieben Summenzeilen davor kosteten mobil rund 600px).
 * Ohne Ausgaben gibt es nichts zu summieren, und beide Abschnitte entfallen.
 */
function renderTotalsSections(SectionTag) {
  const members = renderMemberTotals();
  const categories = renderCategoryTotals();
  return `${members ? `
      <section class="split-section split-section--totals">
        <div class="split-section-head">
          <div class="split-section-head__lead">
            <${SectionTag} class="split-section-title u-section-title">${t('splitExpenses.totalsByMember')}</${SectionTag}>
            <span>${t('splitExpenses.totalsByMemberHint')}</span>
          </div>
        </div>
        ${members}
      </section>` : ''}${categories ? `
      <section class="split-section split-section--totals">
        <div class="split-section-head">
          <${SectionTag} class="split-section-title u-section-title">${t('splitExpenses.totalsByCategory')}</${SectionTag}>
        </div>
        ${categories}
      </section>` : ''}`;
}

function renderBalances() {
  const debts = state.balances.simplified_debts || [];
  // Die eine eigene Schuld steht schon als Kennzahl (foldedDebt): hier nicht
  // ein zweites Mal.
  if (foldedDebt()) return '';
  if (!debts.length) return `<div class="split-muted">${t('splitExpenses.noBalances')}</div>`;
  return `<div class="row-carrier">${debts.map((debt) => `
    <div class="split-debt">
      <span>${esc(debtSentence(debt))}</span>
      <strong>${money(debt.amount, debt.currency)}</strong>
    </div>
  `).join('')}</div>`;
}

// Regel 6 aus utils/module-access.js: der Parameter hiess `readOnly` und meinte
// die archivierte Gruppe. Er heisst jetzt nach dem, was er bewirkt - der
// Aufrufer odert Archiv und Modulrecht hinein (renderMain).
function renderExpenses(asList = false) {
  // Unter einem Filter sagt die leere Liste, dass der Filter der Grund ist (#1941).
  if (!state.expenses.length) return `<div class="split-muted">${t(state.category ? 'splitExpenses.noExpensesInCategory' : 'splitExpenses.noExpenses')}</div>`;
  // "Mehr laden" (#2108) ist derselbe Knopf wie im Verlauf (#1309), mit
  // demselben Text: Lesen, keine Handlung, also bei jedem Recht und im Archiv.
  // Waehrend eine Seite unterwegs ist `aria-disabled` statt `disabled`, damit
  // der Fokus bleibt; den zweiten Klick faengt loadMoreExpenses() ab.
  const busy = state.expensesLoadingMore;
  const more = state.expensesCursor
    ? `<button type="button" class="btn btn--secondary split-expenses-more" data-expenses-more${busy ? ' aria-disabled="true" aria-busy="true"' : ''}>${esc(t('splitExpenses.loadMoreActivity'))}</button>`
    : '';
  return `<div class="row-carrier split-expense-rows" tabindex="-1">${state.expenses.map((expense) => {
    // Beleg-Marke (#583): dass ein Nachweis vorliegt, ist die Information -
    // wie viele es sind, beantwortet keine Frage vor dem Öffnen.
    const receiptCount = expense.attachments?.length ?? 0;
    const receiptMark = receiptCount
      ? ` <span class="split-expense__receipt" role="img" aria-label="${esc(t('splitExpenses.receiptsAttachedLabel', { count: receiptCount }))}"><i data-lucide="paperclip" aria-hidden="true"></i></span>`
      : '';
    const categoryMeta = expense.budget_category ? ` · ${esc(categoryLabel(expense.budget_category))}` : '';
    const body = `
      ${categoryDotHtml(expense.budget_category)}
      <div class="split-expense__body">
        <strong>${esc(expense.title)}</strong>
        <span>${t('splitExpenses.paidBy')}: ${esc(expense.payer_name || '')} · ${dateText(expense.expense_date)}${categoryMeta}${receiptMark}</span>
      </div>
      <div class="split-expense__amount">${money(expense.amount, expense.currency)}</div>
    `;
    // Im Archiv und bei `budget: read` oeffnet der Eintrag die LESEANSICHT
    // (#1265 P7), nicht das Bearbeiten - deshalb nennt sein Name dort keine
    // Handlung, der Inhalt (Titel, Zahler, Datum, Betrag) sagt, was er ist.
    if (asList) {
      return `
      <button type="button" class="split-expense" data-expense-view="${expense.id}" data-row-key="expense-${expense.id}">
        ${body}
      </button>
    `;
    }
    return `
      ${/* NAME AUS DEM INHALT, DIE HANDLUNG ALS NACHSATZ (R20, WCAG 2.5.3):
           das `aria-label` „<Titel> - Ausgabe bearbeiten" liess Zahler, Datum
           und Betrag weg, die die Zeile zeigt - wer per Sprache „38,50"
           ansagte, traf nichts. Jetzt liest die Zeile, was sie zeigt, und
           nennt danach, was der Tipp tut. */ ''}
      <button type="button" class="split-expense" data-expense-id="${expense.id}" data-row-key="expense-${expense.id}">
        ${body}
      </button>
    `;
  }).join('')}</div>${more}`;
}

/**
 * Zeichnet nur die Ausgabenliste neu (nach "Mehr laden"), wie
 * renderActivityBox den Verlauf. Hatte der Knopf den Fokus, bekommt ihn der
 * neue - oder, ist alles geladen, die Liste.
 */
function renderExpenseBox({ keepFocus = false } = {}) {
  const box = _container?.querySelector('#split-expense-list');
  if (!box) return;
  setHtml(box, renderExpenses(isArchivedView() || readOnly()));
  if (typeof window !== 'undefined' && window.lucide) lucide.createIcons({ el: box });
  if (!keepFocus) return;
  (box.querySelector('[data-expenses-more]') || box.querySelector('.split-expense-rows'))?.focus?.();
}

/** Der Rhythmus einer Serie in Worten - die Intervall-Namen des Budgets. */
function frequencyLabel(frequency) {
  return t(`budget.interval${frequency.charAt(0).toUpperCase()}${frequency.slice(1)}`);
}

/** Darf an dieser Serie gehandelt werden: Modulrecht, kein Archiv, und die Regel des Servers. */
function mayActOnRecurring(recurring) {
  return !readOnly() && !isArchivedView() && Boolean(recurring?.can_edit);
}

/**
 * Wiederkehrende Ausgaben der Gruppe (#1647). Bis hierher zeigte die App sie
 * nirgends: eine vom Buchungslauf pausierte Serie stand nur im Verlauf, und
 * fortsetzen, aendern oder loeschen liess sie sich allein ueber die API.
 *
 * ZUSTAND BLEIBT, HANDLUNG GEHT (Nur-lesen-Regel): Titel, Betrag, Rhythmus,
 * naechster Termin, "Pausiert" und der Grund, warum eine Serie nicht bucht,
 * stehen bei jedem Recht und im Archiv. Bearbeiten (die Zeile), Pausieren /
 * Fortsetzen (der Knopf daneben) und Anlegen (der Knopf darunter) gibt es nur
 * mit Schreibrecht ausserhalb des Archivs - und die ersten beiden nur an einer
 * Serie, fuer die der Server `can_edit` meldet (Verwalter oder wer sie angelegt
 * hat). Sonst oeffnet die Zeile die Leseansicht.
 *
 * DIE ZEILE TRAEGT IN 300PX (Critique R17). Der Abschnitt steht in der rechten
 * Spalte des Gruppenrasters, und dort blieben der Textspalte neben Marke,
 * Betrag und Umschalter 68px: der Titel gekappt, "Naechster Termin" dreizeilig,
 * die Zeile 134px hoch und beim Pausieren 98px. Das Markup der Zeile ist
 * geblieben, die Anordnung macht split-expenses.css (Titel / Betrag + Rhythmus
 * / Termin oder Zustand); der Umschalter ist die geteilte Zeilenaktion
 * (`rowActionHtml`) statt eines umrandeten Knopfes.
 *
 * Der Grund (`blocked_reason`) ist am heutigen Stand gemessen: er steht auch an
 * einer laufenden Serie, die der naechste Lauf pausieren wuerde, und faellt,
 * sobald eine Bearbeitung sie repariert hat.
 */
function renderRecurring(asList = false) {
  if (!state.recurring.length) return `<div class="split-muted">${t('splitExpenses.recurring.empty')}</div>`;
  const rows = state.recurring.map((recurring) => {
    const paused = Boolean(recurring.paused_at);
    const when = paused
      ? `<span class="split-recurring__state">${esc(t('splitExpenses.recurring.paused'))}</span>`
      : `<span>${esc(`${t('splitExpenses.recurring.nextDate')}: ${dateText(recurring.next_run_date)}`)}</span>`;
    const reason = recurring.blocked_reason
      ? `<span class="split-recurring__reason">${esc(t(`splitExpenses.recurring.reason.${recurring.blocked_reason}`))}</span>`
      : '';
    // Unerwartet gescheitert (#1746): die Serie laeuft weiter, der Lauf
    // versucht sie stuendlich - gesagt wird es hier, nicht nur im Serverlog.
    const failing = recurringIsFailing(recurring)
      ? `<span class="split-recurring__reason">${esc(t('splitExpenses.recurring.failing'))}</span>`
      : '';
    const body = `
      ${categoryDotHtml(recurring.budget_category)}
      <div class="split-expense__body">
        <strong>${esc(recurring.title)}</strong>
        <span>${esc(frequencyLabel(recurring.frequency))}</span>
        ${when}
        ${reason}
        ${failing}
      </div>
      <div class="split-expense__amount">${money(recurring.amount, recurring.currency)}</div>
    `;
    const acts = !asList && recurring.can_edit;
    const toggleLabel = t(paused ? 'splitExpenses.recurring.resume' : 'splitExpenses.recurring.pause');
    return `
      <div class="split-recurring-row${paused ? ' split-recurring-row--paused' : ''}" data-row-key="recurring-${recurring.id}">
        ${acts
    ? `<button type="button" class="split-expense" data-recurring-id="${recurring.id}">${body}<span class="sr-only"> - ${esc(t('splitExpenses.recurring.edit'))}</span></button>
        ${rowActionHtml({
    icon: paused ? 'play' : 'pause',
    label: `${recurring.title} - ${toggleLabel}`,
    className: 'split-recurring-toggle',
    attrs: { 'data-recurring-toggle': recurring.id, title: toggleLabel },
  })}`
    : `<button type="button" class="split-expense" data-recurring-view="${recurring.id}">${body}</button>`}
      </div>`;
  }).join('');
  return `<div class="row-carrier">${rows}</div>`;
}

/** Delegierter Klick in der Serienliste. */
function onRecurringClick(e) {
  const toggle = e.target.closest('[data-recurring-toggle]');
  if (toggle) return toggleRecurring(Number(toggle.dataset.recurringToggle));
  const row = e.target.closest('[data-recurring-view], [data-recurring-id]');
  if (!row) return undefined;
  const recurring = state.recurring.find((item) => item.id === Number(row.dataset.recurringView ?? row.dataset.recurringId));
  if (!recurring) return undefined;
  // openRecurringModal() verzweigt selbst in die Leseansicht, wenn hier nicht
  // gehandelt werden darf - der Riegel haengt nicht am Markup.
  return openRecurringModal(recurring);
}

/** Vom Verlaufseintrag "automatisch pausiert" zur Zeile der Serie. */
function jumpToRecurring(id) {
  const row = _container?.querySelector(`[data-recurring-id="${id}"], [data-recurring-view="${id}"]`);
  if (!row) return;
  row.scrollIntoView?.({ block: 'center' });
  row.focus?.();
}

// Ein zweiter Klick, waehrend der Umschalter unterwegs ist, tut nichts: die
// Route ist ein Umschalter, zwei Aufrufe hintereinander hoeben sich auf.
let _recurringToggleBusy = false;

/**
 * DIE FRAGE BEIM FORTSETZEN - ein eigener Dialog mit zwei beschrifteten
 * Antworten, in der Bauart der Reichweiten-Frage des Kalenders
 * (`recurringScopeChoice`): gestapelte Knoepfe, darunter "Abbrechen".
 *
 * Zuerst war es der geteilte Auswahldialog. Dessen Bestaetigen-Knopf heisst
 * "Speichern", was hier nichts sagt, und das Select kuerzte die laengere
 * Antwort im schmalen Dialog. Jetzt nennt ein Satz, wie viele Termine seit
 * wann versaeumt wurden, und jeder Knopf sagt selbst, was er tut und ab
 * welchem Tag - der Text bricht um, statt gekuerzt zu werden.
 *
 * "Ab <naechster Termin> fortsetzen" steht zuerst und ist der Hauptknopf: es
 * ist die Vorgabe des Servers (`missed: skip`). Beide Daten kommen vom Server
 * (`resume_date` rechnet er mit der Rechnung des Buchungslaufs).
 *
 * Loest zu 'skip' | 'book' | null. Escape, X, Overlay und "Abbrechen" liefern
 * null - die Serie bleibt dann pausiert.
 */
function recurringResumeChoice(recurring) {
  return recurringMissedChoice({
    title: t('splitExpenses.recurring.missedQuestion'),
    detail: t('splitExpenses.recurring.missedDetail', { count: recurring.missed_count, date: dateText(recurring.next_run_date) }),
    skipLabel: t('splitExpenses.recurring.missedSkip', { date: dateText(recurring.resume_date) }),
    from: recurring.next_run_date,
  });
}

/**
 * Der Dialog hinter beiden Fragen nach versaeumten Terminen: beim Fortsetzen
 * (`recurringResumeChoice`) und beim Anlegen oder Verlegen auf ein Datum vor
 * heute (`recurringPastDateChoice`, #1748). Gleich gebaut, damit dieselbe
 * Entscheidung gleich aussieht: der Satz, "ab dem naechsten Termin" als
 * Hauptknopf (die Vorgabe `missed: skip`), "ab `from` nachbuchen", Abbrechen.
 */
function recurringMissedChoice({ title, detail, skipLabel, from }) {
  return new Promise((resolve) => {
    let resolved = false;
    const finish = (value) => {
      if (resolved) return;
      resolved = true;
      closeModal({ force: true });
      resolve(value);
    };
    openSharedModal({
      pointerDeadTime: true,
      title,
      size: 'sm',
      content: `
        <p class="modal-confirm__detail" id="split-resume-detail">${esc(detail)}</p>
        <div class="modal-actions modal-actions--stack">
          <div class="modal-actions modal-actions--stack split-resume-choices" role="group" aria-labelledby="split-resume-detail">
            <button type="button" class="btn btn--primary" data-resume="skip">${esc(skipLabel)}</button>
            <button type="button" class="btn btn--secondary" data-resume="book">${esc(t('splitExpenses.recurring.missedBook', { date: dateText(from) }))}</button>
          </div>
          <button type="button" class="btn btn--secondary" id="split-resume-cancel">${esc(t('common.cancel'))}</button>
        </div>`,
      onClose: () => finish(null),
      onSave(panel) {
        for (const button of panel.querySelectorAll('[data-resume]')) {
          button.addEventListener('click', () => finish(button.dataset.resume));
        }
        panel.querySelector('#split-resume-cancel')?.addEventListener('click', () => finish(null));
      },
    });
  });
}

/**
 * DIE FRAGE BEIM ANLEGEN UND VERLEGEN (#1748). Ein Termin vor heute buchte
 * frueher still nach: der stuendliche Lauf holte je Lauf einen versaeumten
 * Termin auf, eine Serie mit Start im Januar 2024 wurde einen Tag lang
 * stuendlich zur Ausgabe. Jetzt fragt der Dialog wie beim Fortsetzen.
 *
 * Gefragt wird nur, wenn der Aufruf den Termin SENDET (neu angelegt oder
 * verlegt), die Serie nicht pausiert ist (das Fortsetzen fragt dann selbst)
 * und vor heute wirklich ein Termin liegt. Zahl und naechster Termin kommen aus
 * `nextRunNotBefore`, derselben Datei, mit der der Server bei `missed: skip`
 * weiterstellt, mit dem Ankertag des eingegebenen Datums wie dort.
 *
 * Loest zu undefined (keine Frage), 'skip' | 'book' oder null (abgebrochen:
 * der Dialog bleibt offen, nichts wird gesendet). Die Frage steht ueber dem
 * Formular (`askOverModal`), das danach mit seiner Eingabe zurueckkommt.
 */
async function recurringPastDateChoice(now, payload, recurring) {
  if (recurring && (payload.next_run_date === undefined || recurring.paused_at)) return undefined;
  const date = String(now.next_run_date || '');
  const today = todayKey();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !(date < today)) return undefined;
  const next = nextRunNotBefore(date, now.frequency, today, Number(date.slice(8, 10)));
  if (!next.skipped) return undefined;
  const answer = await askOverModal(() => recurringMissedChoice({
    title: t('splitExpenses.recurring.pastQuestion'),
    detail: t('splitExpenses.recurring.pastDetail', { count: next.skipped, date: dateText(date) }),
    skipLabel: t('splitExpenses.recurring.pastSkip', { date: dateText(next.date) }),
    from: date,
  }));
  return answer === 'skip' || answer === 'book' ? answer : null;
}

/**
 * Pausieren oder Fortsetzen (#1647). Fortsetzen stellt EINE Frage, und nur,
 * wenn waehrend der Pause Termine faellig gewesen waeren
 * (`recurringResumeChoice`): ab dem naechsten Termin weiter oder die
 * versaeumten nachbuchen. Ohne versaeumte Termine setzt der Knopf direkt fort.
 * Abbrechen laesst die Serie pausiert.
 */
async function toggleRecurring(id) {
  const recurring = state.recurring.find((item) => item.id === id);
  if (!mayActOnRecurring(recurring) || _recurringToggleBusy) return;
  let body = {};
  if (recurring.paused_at) {
    body = { missed: 'skip' };
    if (recurring.missed_count > 0) {
      const answer = await recurringResumeChoice(recurring);
      if (answer !== 'skip' && answer !== 'book') return;
      body = { missed: answer };
      // Erst wenn die Frage ganz zu ist (mobil laeuft eine Animation): ihr
      // Schliessen gibt den Fokus an den Umschalter zurueck, und der wird
      // unten neu gezeichnet.
      await whenModalClosed();
    }
  }
  _recurringToggleBusy = true;
  try {
    await api.post(`/split-expenses/recurring/${id}/pause`, body);
  } finally {
    _recurringToggleBusy = false;
    await loadGroupData();
    renderAll();
    // Pausiert <-> laeuft tauscht Zeichen und Termin an derselben Zeile (gleich
    // hoch seit R17): sie blendet ihren neuen Zustand ein statt umzuspringen.
    swapContent(_container?.querySelector(`#split-main [data-row-key="recurring-${id}"]`) ?? null, null);
    // Der Umschalter ist ein neuer Knopf (Pausieren wurde zu Fortsetzen oder
    // umgekehrt). Wer ihn bedient hat, behaelt ihn unter dem Finger bzw. dem
    // Tastaturfokus, statt auf den Seitenanfang zu fallen. Hier schliesst kein
    // Dialog, also greift der Merker von refocusAfterRender() nicht.
    _container?.querySelector(`[data-recurring-toggle="${id}"]`)?.focus?.();
  }
}

/** Die Werte, die Zeile, Knopf und Rueckfrage einer Zahlung nennen (#1309). */
function paymentParams(settlement) {
  return {
    payer: settlement.payer_name || '',
    payee: settlement.payee_name || '',
    amount: money(settlement.amount, settlement.currency),
  };
}

/**
 * Verlauf der Gruppe. Eine eingetragene Zahlung nennt, wer wem wie viel
 * gezahlt hat, und traegt ihren Stand (#1309): storniert ist ein ZEICHEN, das
 * bei jedem Recht stehen bleibt; „Stornieren" ist eine Handlung und erscheint
 * nur, wenn der Server `can_reverse` meldet (Verwalter oder wer sie
 * eingetragen hat - die Regel wohnt dort), das Modul beschreibbar ist und die
 * Gruppe nicht im Archiv liegt.
 */
function renderActivity() {
  if (!state.activity.length) return `<div class="split-muted">${t('splitExpenses.noActivity')}</div>`;
  const actionable = !readOnly() && !isArchivedView();
  const items = state.activity.map((item) => activityItemHtml(item, actionable)).join('');
  // "Mehr laden" (#1309) ist Lesen, keine Handlung: er steht bei jedem Recht
  // und im Archiv, solange der Server eine weitere Seite meldet.
  // Waehrend eine Seite unterwegs ist: `aria-disabled` statt `disabled`, damit
  // der Knopf den Fokus behaelt (ein gesperrter Knopf verliert ihn an die
  // Seite); den zweiten Klick faengt loadMoreActivity() ab.
  const busy = state.activityLoadingMore;
  const more = state.activityCursor
    ? `<button type="button" class="btn btn--secondary split-activity-more" data-activity-more${busy ? ' aria-disabled="true" aria-busy="true"' : ''}>${esc(t('splitExpenses.loadMoreActivity'))}</button>`
    : '';
  return `<div class="split-activity-list row-carrier" tabindex="-1">${items}</div>${more}`;
}

/**
 * Welche Ausgabe Migration v226 wiederhergestellt (#1382) oder v227 entfernt
 * hat (#1445): Titel und gebuchter Betrag, damit mehrere solcher Eintraege
 * unterscheidbar sind. Eine entfernte Ausgabe steht in keiner Liste mehr -
 * was der Eintrag nennt, kommt allein aus seinen Metadaten. Den Betrag
 * rechnet der Server in `amount` um - er kennt die Nachkommastellen je
 * Waehrung (ISO 4217), der Browser nicht.
 */
const LEDGER_REPAIR_ACTIVITY = new Set(['ledger_restored', 'ledger_removed']);

function restoredDetail(item) {
  if (!LEDGER_REPAIR_ACTIVITY.has(item.type) || !item.metadata?.title) return '';
  const { title, amount, currency } = item.metadata;
  const sum = amount != null && currency ? ` · ${money(amount, currency)}` : '';
  return `<span class="split-activity-payment">${esc(`${title}${sum}`)}</span>`;
}

/**
 * WELCHE AUSGABE (Re-Critique 2026-09-27, A5 P2-8 / R10 L11). Der Verlauf las
 * fuenfmal „Ausgabe erstellt - Alex Johnson - 23.09.2026", ohne zu sagen,
 * welche - daneben nannte „Letzte Ausgaben" das Objekt.
 *
 * Titel UND Betrag kommen aus den Metadaten, die der Server beim Schreiben
 * festhaelt (#1607): der Verlauf ist Geschichte. Aus der geladenen Ausgabe
 * gelesen, zeigte jeder fruehere Eintrag den HEUTIGEN Betrag - eine
 * Bearbeitung schrieb „erstellt ueber 50" nachtraeglich auf 10 um. Ein Eintrag
 * von vor dem Snapshot traegt keinen Betrag; dann bleibt der Titel allein, der
 * heutige Betrag waere fuer damals geraten. Die Dezimalform `amount` rechnet
 * der Server (ISO 4217 kennt er, der Browser nicht).
 *
 * Nur der Titel eines Kommentars darf noch aus der geladenen Ausgabe kommen:
 * aeltere Kommentar-Eintraege tragen keine Metadaten, und der Titel benennt
 * die Ausgabe, er behauptet keinen Stand von damals.
 */
const EXPENSE_ACTIVITY = new Set(['expense_created', 'expense_edited', 'expense_deleted', 'comment_added', 'recurring_created', 'recurring_generated', 'recurring_auto_paused', 'recurring_edited', 'recurring_deleted']);

function expenseDetail(item) {
  if (!EXPENSE_ACTIVITY.has(item.type)) return '';
  const { title: snapshotTitle, amount, currency } = item.metadata || {};
  const loaded = !snapshotTitle && item.type === 'comment_added' && item.entity_type === 'expense' && item.entity_id != null
    ? state.expenses.find((e) => e.id === Number(item.entity_id))
    : null;
  const title = snapshotTitle || loaded?.title;
  if (!title) return '';
  const sum = amount != null && currency ? ` · ${money(amount, currency)}` : '';
  return `<span class="split-activity-payment">${esc(`${title}${sum}`)}</span>`;
}

/**
 * Ein Eintrag des Verlaufs. Nachgeladene Seiten laufen durch dieselbe Funktion
 * und dieselbe Klick-Delegation am Verlauf - ein Storno-Knopf auf Seite drei
 * ist derselbe Knopf wie auf Seite eins.
 *
 * Das Datum ist der Tag in der Haushaltszone: `created_at` ist ein Zeitpunkt in
 * UTC, und `slice(0, 10)` darauf waere der UTC-Tag - 23:30 UTC in Berlin ist
 * schon der naechste Tag.
 */
function activityItemHtml(item, actionable) {
  const settlement = item.settlement;
  const params = settlement ? paymentParams(settlement) : null;
  // Eine geloeschte Ausgabe (#1382) bleibt im Verlauf lesbar: der Eintrag, der
  // sie angelegt hat, traegt „Geloescht" als Zeichen und ist durchgestrichen -
  // wie eine stornierte Zahlung. Der Loesch-Eintrag selbst nennt nur, was
  // geloescht wurde; sein Typ sagt den Rest. Titel und Betrag kommen wie bei
  // jedem Ausgaben-Eintrag aus den Metadaten (`expenseDetail`), `item.expense`
  // sagt nur, ob es die Ausgabe noch gibt.
  const expenseGone = Boolean(item.expense?.deleted_at) && item.type !== 'expense_deleted';
  const detail = settlement
    ? `<span class="split-activity-payment">${esc(t('splitExpenses.paymentDetail', params))}</span>`
    : restoredDetail(item) || expenseDetail(item);
  let reversed = '';
  if (settlement?.reversed_at) {
    reversed = `<span class="split-activity-reversed">${esc(t('splitExpenses.paymentReversed'))}</span>`;
  } else if (expenseGone) {
    reversed = `<span class="split-activity-reversed">${esc(t('splitExpenses.expenseDeleted'))}</span>`;
  }
  let action = settlement?.can_reverse && !settlement.reversed_at && actionable
    ? `<button type="button" class="btn btn--secondary split-reverse-payment" data-reverse-settlement="${settlement.id}" aria-label="${esc(t('splitExpenses.reversePaymentLabel', params))}">${esc(t('splitExpenses.reversePayment'))}</button>`
    : '';
  // "Automatisch pausiert" fuehrt zu seiner Serie (#1647): dort steht der
  // Grund, und wer darf, repariert sie. Hinsehen ist Lesen - der Knopf steht
  // bei jedem Recht und im Archiv, aber nur, solange es die Serie noch gibt.
  const pausedSeries = item.type === 'recurring_auto_paused' && item.entity_type === 'recurring_expense'
    ? state.recurring.find((r) => r.id === Number(item.entity_id))
    : null;
  if (pausedSeries) {
    action = `<button type="button" class="btn btn--secondary split-reverse-payment" data-recurring-jump="${pausedSeries.id}" aria-label="${esc(`${pausedSeries.title} - ${t('splitExpenses.recurring.show')}`)}">${esc(t('splitExpenses.recurring.show'))}</button>`;
  }
  return `
    <div class="split-activity-item${settlement?.reversed_at || expenseGone ? ' split-activity-item--reversed' : ''}">
      <span class="split-activity-dot"></span>
      <div>
        <strong>${esc(t(`splitExpenses.activityType.${item.type}`))}</strong>
        ${detail}
        <span>${esc(item.actor_name || t('splitExpenses.system'))} · ${esc(dateText(zonedDateKey(item.created_at)))}</span>
        ${reversed}
      </div>
      ${action}
    </div>
  `;
}

/**
 * Zeichnet nur den Verlauf neu, nicht die ganze Gruppe: der Klick-Lauscher
 * haengt am Kasten `.split-activity`, der stehen bleibt. Hatte "Mehr laden" den
 * Fokus, bekommt ihn der neue Knopf - oder, ist alles geladen, die Liste, damit
 * er nicht auf den Seitenanfang faellt.
 */
function renderActivityBox({ keepFocus = false } = {}) {
  const box = _container?.querySelector('.split-activity');
  if (!box) return;
  box.replaceChildren();
  box.insertAdjacentHTML('beforeend', renderActivity());
  if (!keepFocus) return;
  (box.querySelector('[data-activity-more]') || box.querySelector('.split-activity-list'))?.focus?.();
}

/** Delegierter Klick im Verlauf: "Mehr laden" liest, der einzige Schreibweg dort ist das Storno. */
function onActivityClick(e) {
  if (e.target.closest('[data-activity-more]')) return loadMoreActivity();
  const jump = e.target.closest('[data-recurring-jump]');
  if (jump) return jumpToRecurring(Number(jump.dataset.recurringJump));
  const btn = e.target.closest('[data-reverse-settlement]');
  if (!btn) return undefined;
  return reverseSettlement(Number(btn.dataset.reverseSettlement));
}

/**
 * Storno einer Zahlung (#1309): Rueckfrage, dann die Gegenbuchung auf dem
 * Server. Nichts wird geloescht - die Zahlung bleibt im Verlauf, als storniert
 * markiert. Scheitert der Aufruf (etwa 409, weil jemand anderes schneller war),
 * wird trotzdem neu geladen, damit der Schirm den wirklichen Stand zeigt; der
 * Fehler selbst geht an die globale Meldung. Das Neuladen behaelt die geladene
 * Tiefe des Verlaufs (loadGroupData): wer auf Seite drei storniert, sieht die
 * Zahlung danach dort als storniert, statt auf die erste Seite zurueckzufallen.
 */
async function reverseSettlement(settlementId) {
  if (readOnly()) return;
  const settlement = state.activity.find((item) => item.settlement?.id === settlementId)?.settlement;
  if (!settlement?.can_reverse || settlement.reversed_at) return;
  const groupId = state.activeGroupId;
  const confirmed = await confirmModal(t('splitExpenses.reversePaymentConfirm'), {
    confirmLabel: t('splitExpenses.reversePayment'),
    detail: t('splitExpenses.reversePaymentConfirmDetail', paymentParams(settlement)),
  });
  if (!confirmed) return;
  try {
    await api.post(`/split-expenses/groups/${groupId}/settlements/${settlementId}/reverse`, {});
  } finally {
    await refreshDashboard();
    await loadGroupData();
    renderAll();
    refocusAfterRender();
  }
}

/**
 * DIE KATEGORIE EINER AUSGABE HAT EINE FARBE (R22, D9). Die Lead-Kachel der
 * Zeile ist getoent wie die eines Kontos oder Abos; die Farbe kommt aus der
 * Datenreihen-Palette (tokens.css, dieselbe wie die Budget-Kategorien), fest
 * je Kategorie in der Reihenfolge der Auswahl, damit sie sich nie verschiebt.
 * "Allgemein" (und was unbekannt ist) bleibt neutral - der Rest der Liste
 * sagt es ueber das Zeichen.
 */
async function archiveGroup(groupId) {
  if (readOnly()) return;
  const confirmed = await confirmModal(t('splitExpenses.archiveGroupConfirm'), {
    confirmLabel: t('splitExpenses.archiveGroup'),
  });
  if (!confirmed) return;
  await api.post(`/split-expenses/groups/${groupId}/archive`, {});
  await refreshDashboard();
  await loadGroups();
  await loadGroupData();
  renderAll();
  refocusAfterRender();
}

/**
 * Holt eine archivierte Gruppe zurück in die aktive Liste und wechselt dorthin.
 * Bewusst ohne Rückfrage: der Schritt ist verlustfrei und über Archivieren
 * jederzeit umkehrbar.
 */
async function restoreGroup(groupId) {
  if (readOnly()) return;
  await api.post(`/split-expenses/groups/${groupId}/unarchive`, {});
  state.groupStatus = 'active';
  state.activeGroupId = groupId;
  await refreshDashboard();
  await loadGroups();
  await loadGroupData();
  renderAll();
}

async function refreshDashboard() {
  const dash = await api.get('/split-expenses/dashboard');
  state.dashboard = dash.data;
}

async function deleteGroup(groupId) {
  if (readOnly()) return;
  const confirmed = await confirmModal(t('splitExpenses.deleteGroupConfirm'), {
    danger: true,
    confirmLabel: t('splitExpenses.deleteGroup'),
    detail: t('splitExpenses.deleteGroupConfirmDetail'),
  });
  if (!confirmed) return;
  await api.delete(`/split-expenses/groups/${groupId}`);
  await refreshDashboard();
  await loadGroups();
  await loadGroupData();
  renderAll();
  refocusAfterRender();
}

function memberOptions(selectedId = '', source = state.groupMembers.length ? state.groupMembers : state.members) {
  return source.map((member) => {
    const id = member.id ?? member.user_id;
    return `<option value="${id}" ${String(id) === String(selectedId) ? 'selected' : ''}>${esc(member.display_name)}</option>`;
  }).join('');
}

function memberCandidateOptions(candidates = []) {
  return candidates
    .filter((candidate) => !candidate.in_group)
    .map((candidate) => {
      const value = candidate.source === 'contact' ? `contact:${candidate.contact_id}` : `user:${candidate.user_id}`;
      const suffix = candidate.source === 'contact' ? ` · ${t('nav.contacts')}` : '';
      return `<option value="${esc(value)}">${esc(candidate.display_name)}${suffix}</option>`;
    }).join('');
}

/**
 * DIE BETEILIGTEN ALS PERSONEN-CHIPS (Critique R24 G4-Budget-P1-1, Sam).
 * Hier standen native 13px-Kaestchen in einem rohen `<fieldset>` - waehrend
 * Budget, Kalender und Mahlzeiten Personen mit Scheibe und Namen waehlen
 * (renderUserMultiSelect). Jetzt dieselbe Form (`.user-ms__option`: Scheibe,
 * Vorname, eine Trefferflaeche je Person, Haken im Chip); daneben steht je
 * Person der Wert der Aufteilung, solange die Art einen braucht. Gleich
 * verteilt bleiben die Chips eine umbrechende Reihe wie im Baustein.
 * Die Kaestchen behalten `name="participants"` - Pruefung und Senden lesen sie.
 */
function participantChip(member, checked, name = 'participants', value = member.id ?? member.user_id, extra = '') {
  const color = safeHexColor(member.avatar_color);
  const inner = member.avatar_data
    ? `<img src="${esc(member.avatar_data)}" alt="" loading="lazy">`
    : esc(initials(member.display_name));
  return `<label class="user-ms__option">
        <input type="checkbox" class="user-ms__checkbox" name="${esc(name)}" value="${esc(String(value))}" data-ms-input="${esc(name)}"${checked ? ' checked' : ''}${extra}>
        <span class="user-ms__avatar" style="background-color:${color};color:${getReadableTextColor(color)}">${inner}</span>
        <span class="user-ms__name">${esc(member.display_name ?? '')}</span>
      </label>`;
}

function groupMemberCheckboxes(selectedIds = null, splitValues = {}) {
  const members = state.groupMembers.length ? state.groupMembers : state.members;
  const selectedSet = selectedIds ? new Set(selectedIds.map(Number)) : null;
  const rows = members.map((member) => {
    const id = member.id ?? member.user_id;
    const checked = selectedSet ? selectedSet.has(Number(id)) : true;
    const value = splitValues[id] ?? '';
    return `
    <div class="split-participant-row" data-participant-row="${id}">
      ${participantChip(member, checked)}
      <input class="form-input split-split-value" name="split_value_${id}" inputmode="decimal" aria-label="${esc(member.display_name)} ${t('splitExpenses.splitValue')}" placeholder="" value="${esc(value)}">
    </div>
  `;
  }).join('');
  return `
    <div class="form-field split-participants user-ms" data-ms-name="participants" role="group" aria-labelledby="split-participants-label">
      <span class="form-label" id="split-participants-label">${t('splitExpenses.participants')}${REQUIRED_MARK}</span>
      <div class="user-ms__options split-participant-list">${rows}</div>
    </div>`;
}

/**
 * Rekonstruiert die pro-Teilnehmer Split-Eingabewerte aus einer gespeicherten
 * Ausgabe, damit der Bearbeiten-Dialog denselben Aufteilungsmodus vorbelegt.
 * - exact: exakte Beträge (verlustfrei)
 * - percentage: Prozentanteile, Restbetrag auf letzten Teilnehmer (Summe = 100)
 * - shares: ganzzahlige Anteile über den ggT der Minor-Beträge
 * - equal: keine Werte nötig
 *
 * Die Werte landen in Eingabefeldern und stehen deshalb in der Schreibweise der
 * Region (amountToInput / toStoredNumber aus utils/money.js): gelesen werden sie
 * von toDecimalString, und ein Feld, das "12.50" vorbelegt und "0,00" als
 * Platzhalter zeigt, widerspricht sich selbst.
 */
function deriveSplitValues(expense) {
  const method = expense.split_method;
  const splits = expense.splits || [];
  const values = {};
  if (method === 'exact') {
    for (const split of splits) values[split.user_id] = amountToInput(split.amount, split.currency || expense.currency);
  } else if (method === 'percentage') {
    const totalMinor = splits.reduce((sum, split) => sum + Math.abs(Number(split.amount_minor || 0)), 0) || 1;
    let acc = 0;
    splits.forEach((split, index) => {
      if (index === splits.length - 1) {
        values[split.user_id] = toStoredNumber(Number((100 - acc).toFixed(2)));
      } else {
        const pct = Number(((Math.abs(Number(split.amount_minor || 0)) / totalMinor) * 100).toFixed(2));
        acc += pct;
        values[split.user_id] = toStoredNumber(pct);
      }
    });
  } else if (method === 'shares') {
    const amounts = splits.map((split) => Math.abs(Number(split.amount_minor || 0)));
    const divisor = amounts.reduce((a, b) => splitGcd(a, b), 0) || 1;
    splits.forEach((split, index) => {
      values[split.user_id] = String(Math.max(1, Math.round(amounts[index] / divisor)));
    });
  }
  return values;
}

function splitGcd(a, b) {
  return b === 0 ? a : splitGcd(b, a % b);
}

/**
 * Standard-Aufteilung einer Gruppe (#517). Die API liefert default_split_config
 * als JSON-String ([{ user_id, percentage }] bzw. [{ user_id, shares }]); dieser
 * Helfer parst tolerant in ein Array.
 */
function parseSplitConfig(raw) {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw;
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/**
 * Übersetzt die gespeicherte Standard-Config einer Gruppe in die pro-Mitglied
 * Split-Eingabewerte, mit denen eine neue Ausgabe vorbelegt wird. Nur für
 * percentage/shares relevant; equal/exact brauchen keine Werte.
 */
function defaultSplitValues(group) {
  const method = group?.default_split_method;
  if (method !== 'percentage' && method !== 'shares') return {};
  const values = {};
  for (const entry of parseSplitConfig(group?.default_split_config)) {
    values[entry.user_id] = method === 'shares' ? String(entry.shares) : String(entry.percentage);
  }
  return values;
}

function updateSplitInputs(panel) {
  const method = panel.querySelector('[name="split_method"]')?.value || 'equal';
  // Der Betrag und die Teilbeträge stehen in der gewählten Währung; Prozente
  // und Anteile sind reine Zahlen und behalten ihren festen Platzhalter.
  const currency = panel.querySelector('[name="currency"]')?.value || state.meta?.default_currency || 'EUR';
  const zero = amountPlaceholder(currency);
  const amountInput = panel.querySelector('[name="amount"]');
  if (amountInput) amountInput.placeholder = zero;
  panel.querySelectorAll('.split-split-value').forEach((input) => {
    input.hidden = method === 'equal';
    input.required = method !== 'equal';
    if (method === 'percentage') input.placeholder = '30';
    else if (method === 'exact') input.placeholder = zero;
    else if (method === 'shares') input.placeholder = '1';
    else input.placeholder = '';
  });
  const hint = panel.querySelector('#split-method-hint');
  validateSplitForm(panel);
}

/**
 * Ein Geldbetrag aus dem Formular in der Schreibweise, die der Server erwartet.
 *
 * parseMoneyToMinor() in server/services/split-expenses.js nimmt ausschliesslich
 * /^-?\d+(\.\d+)?$/ entgegen, die Eingabe folgt dagegen der Region - bis in die
 * Ziffern hinein. Ohne diese Umschrift kommt "12,50" oder "۱۲٫۵۰" unverändert
 * am Server an, und das Anlegen scheitert dort mit einem Fehler, der auf kein
 * Feld zeigt. Die Umschrift selbst steht in utils/money.js, der einen Quelle
 * für Geldformate.
 */
const decimalString = toAmountDecimalString;


/**
 * Weist einen Betrag zurück, den der Server nicht annähme, und nennt den Grund
 * am Feld. Die Felder hier sind Textfelder, es gibt also kein `step`, das der
 * Browser prüfen könnte - und der Platzhalter zeigt bei HUF, IDR oder IRR
 * bereits ganze Einheiten an.
 *
 * Ohne diese Prüfung landet die Ablehnung beim Server (parseMoneyToMinor wirft),
 * und die Meldung erscheint englisch und ortlos statt am Feld, das sie meint.
 *
 * Gelesen wird der TEXT des Feldes, nicht eine Zahl daraus: "10.000" ist unter
 * ko-KR die Zahl 10 und passte so ins Raster von KRW, gesendet wurde aber der
 * Text mit seinen drei Stellen (#1607).
 *
 * `required` setzt jeder Speicherweg: ein leeres Feld zählt dann wie eine 0.
 * Die Genau-Beträge einer Aufteilung haben kein Pflichtfeld des Browsers, und
 * wo es eines gibt, nimmt es ein Feld aus Leerzeichen an - beides ginge als
 * leerer Text an den Server.
 *
 * `original` und `originalCurrency` tragen den Bestandsschutz (siehe
 * amountInputProblem): er endet, sobald die Währung gewechselt wurde.
 *
 * @returns {boolean} true, wenn abgewiesen wurde (der Aufrufer bricht dann ab)
 */
function rejectSplitAmount(input, currency, { original = null, originalCurrency = null, required = false } = {}) {
  if (input == null) return false;
  const problem = amountInputProblem(input.value, currency, { original, originalCurrency, required, decimalComma: true });
  if (!problem) return false;
  reportFieldError(input, amountProblemText(problem, currency));
  return true;
}

/**
 * Der Grund unter dem Betrag der Ausgabe, solange die Eingabe das Speichern
 * sperrt (#1607): 0, negativ, gruppiert oder keine Zahl. Vorher ging nur der
 * Speichern-Knopf aus.
 *
 * `reveal` kommt vom Verlassen des Feldes. Beim Tippen bleibt ein noch nicht
 * gezeigter Grund still - "0" ist der Anfang von "0,50" und "12," der von
 * "12,50". Steht er einmal da, folgt er der Eingabe und geht mit dem Fehler.
 *
 * Zu viele Nachkommastellen stehen NICHT hier: die meldet der Speicherweg am
 * Feld, weil er den Bestandswert kennt (rejectSplitAmount).
 *
 * @returns {boolean} true, wenn der Betrag das Speichern sperrt
 */
function syncAmountReason(panel, currency, { reveal = false } = {}) {
  const input = panel.querySelector('[name="amount"]');
  const problem = amountInputProblem(input?.value, currency, { decimalComma: true });
  const blocking = Boolean(problem) && problem !== 'precision';
  const reason = panel.querySelector('#split-amount-reason');
  if (!input || !reason) return blocking;
  if (!blocking) {
    if (!reason.hidden) input.setAttribute('aria-invalid', 'false');
    reason.hidden = true;
    reason.textContent = '';
  } else if (reveal || !reason.hidden) {
    reason.textContent = amountProblemText(problem, currency);
    reason.hidden = false;
    input.setAttribute('aria-invalid', 'true');
  }
  return blocking;
}

function numberValue(value) {
  const normalized = decimalString(value);
  if (!normalized) return NaN;
  return Number(normalized);
}

/** Eine laufende Prozentsumme im Zahlformat der Region: "33,5 %", "100%". */
function percentTotal(total) {
  return getNumberFormat({ style: 'percent', maximumFractionDigits: 2 }).format(total / 100);
}

function validateSplitForm(panel, { reveal = false } = {}) {
  const method = panel.querySelector('[name="split_method"]')?.value || 'equal';
  const currency = panel.querySelector('[name="currency"]')?.value || state.meta?.default_currency || 'EUR';
  const amount = numberValue(panel.querySelector('[name="amount"]')?.value);
  const amountBlocked = syncAmountReason(panel, currency, { reveal });
  const selected = [...panel.querySelectorAll('input[name="participants"]:checked')];
  let valid = selected.length > 0 && Number.isFinite(amount) && amount > 0 && !amountBlocked;
  let message = t(`splitExpenses.splitHint.${method}`);
  if (valid && method === 'percentage') {
    const total = selected.reduce((sum, input) => sum + (numberValue(panel.querySelector(`[name="split_value_${input.value}"]`)?.value) || 0), 0);
    valid = Math.abs(total - 100) < 0.01;
    message = `${message} ${t('splitExpenses.splitCurrentTotal', { total: percentTotal(total) })}`;
  } else if (valid && method === 'exact') {
    const total = selected.reduce((sum, input) => sum + (numberValue(panel.querySelector(`[name="split_value_${input.value}"]`)?.value) || 0), 0);
    valid = Math.abs(total - amount) < 0.01;
    message = `${message} ${t('splitExpenses.splitCurrentTotal', { total: formatMoney(total, currency) })}`;
  } else if (valid && method === 'shares') {
    valid = selected.every((input) => {
      const value = numberValue(panel.querySelector(`[name="split_value_${input.value}"]`)?.value);
      return Number.isInteger(value) && value > 0;
    });
  }
  const hint = panel.querySelector('#split-method-hint');
  if (hint) hint.textContent = message;
  // DER PRIMAERKNOPF BLEIBT BEDIENBAR (Critique R24 G4-Budget-P1-1, D4): bis
  // R24 war "Hinzufuegen" gesperrt, bis die Aufteilung aufging - ohne zu sagen,
  // was fehlte. Jetzt sagt der Hinweis es laufend, und das Absenden nennt den
  // Grund am Feld (reportSplitProblem).
  return valid;
}

/**
 * Was das Absenden einer Ausgabe oder Serie aufhaelt, am Feld, das es behebt:
 * niemand beteiligt (an der ersten Person), eine Aufteilung, die nicht aufgeht
 * (am ersten Wert, mit demselben Satz wie der Hinweis darunter).
 *
 * @returns {boolean} true, wenn gemeldet wurde (der Aufrufer bricht ab)
 */
function reportSplitProblem(panel) {
  if (validateSplitForm(panel, { reveal: true })) return false;
  const selected = [...panel.querySelectorAll('input[name="participants"]:checked')];
  if (!selected.length) {
    return reportFieldErrors([[panel.querySelector('input[name="participants"]'), t('splitExpenses.participantsRequired')]]);
  }
  // Ein Betrag, der das Absenden aufhaelt, nennt seinen Grund schon unter
  // dem Feld (syncAmountReason, eben mit `reveal` gezeigt): der Fokus geht
  // dorthin, ein zweiter Satz am selben Feld waere eine Dublette.
  const amount = panel.querySelector('[name="amount"]');
  const currency = panel.querySelector('[name="currency"]')?.value || state.meta?.default_currency || 'EUR';
  const amountProblem = amountInputProblem(amount?.value, currency);
  if (amountProblem && amountProblem !== 'precision') {
    amount.focus?.();
    return true;
  }
  const field = selected
    .map((input) => panel.querySelector(`[name="split_value_${input.value}"]`))
    .find((el) => el && !el.hidden);
  const message = panel.querySelector('#split-method-hint')?.textContent || '';
  return reportFieldErrors([[field ?? selected[0], message]]);
}

/**
 * Standard-Aufteilungs-Editor im Gruppen-Modal (#517). Bietet Methode +
 * pro-Mitglied-Werte (percentage/shares), mit denen neue Ausgaben starten.
 * 'exact' ist bewusst nicht wählbar - exakte Beträge hängen vom Ausgabenbetrag
 * ab, ein fixer Default ergibt keinen Sinn. Erst ab zwei Mitgliedern sichtbar.
 */
function renderGroupDefaults(group) {
  const members = state.groupMembers.length ? state.groupMembers : state.members;
  if (members.length < 2) return '';
  const method = group?.default_split_method || 'equal';
  const values = defaultSplitValues(group);
  const opt = (value, label) => `<option value="${value}" ${value === method ? 'selected' : ''}>${label}</option>`;
  return `
    <fieldset class="split-defaults">
      <legend>${t('splitExpenses.defaultSplit')}</legend>
      <p class="form-hint">${t('splitExpenses.defaultSplitHint')}</p>
      <label class="form-field"><span class="form-label">${t('splitExpenses.splitMethod')}</span><select class="form-input" name="default_split_method">
        ${opt('equal', t('splitExpenses.splitEqual'))}
        ${opt('percentage', t('splitExpenses.splitPercentage'))}
        ${opt('shares', t('splitExpenses.splitShares'))}
      </select></label>
      ${members.map((member) => {
        const id = member.id ?? member.user_id;
        return `
        <div class="split-participant-row" data-default-row="${id}">
          <span>${esc(member.display_name)}</span>
          <input class="form-input split-default-value" name="default_value_${id}" inputmode="decimal" aria-label="${esc(member.display_name)} ${t('splitExpenses.splitValue')}" value="${esc(values[id] ?? '')}">
        </div>`;
      }).join('')}
      <p class="form-hint" id="split-default-hint" role="status"></p>
    </fieldset>
  `;
}

/**
 * Zeigt/versteckt die Default-Werte je Methode und blockiert das Speichern der
 * Gruppe nur, wenn eine percentage-Config ausgefüllt ist, aber nicht 100 ergibt.
 * Leere Werte = keine Vorbelegung (erlaubt).
 */
function updateGroupDefaults(panel) {
  const select = panel.querySelector('[name="default_split_method"]');
  if (!select) return true;
  const method = select.value;
  const rows = [...panel.querySelectorAll('.split-default-value')];
  rows.forEach((input) => {
    input.hidden = method === 'equal';
    if (method === 'percentage') input.placeholder = '50';
    else if (method === 'shares') input.placeholder = '1';
    else input.placeholder = '';
  });
  const filled = rows.filter((input) => String(input.value).trim() !== '');
  let valid = true;
  let message = '';
  if (method === 'percentage' && filled.length) {
    const total = rows.reduce((sum, input) => sum + (numberValue(input.value) || 0), 0);
    valid = Math.abs(total - 100) < 0.01;
    message = t('splitExpenses.splitCurrentTotal', { total: percentTotal(total) });
  } else if (method === 'shares' && filled.length) {
    valid = filled.every((input) => {
      const value = numberValue(input.value);
      return Number.isInteger(value) && value > 0;
    });
  }
  const hint = panel.querySelector('#split-default-hint');
  if (hint) hint.textContent = valid ? message : `${t('splitExpenses.defaultSplitInvalid')} ${message}`.trim();
  // Der Primaerknopf bleibt bedienbar (R24, D4); das Absenden meldet den
  // Grund an der ersten Zahl (openGroupModal).
  return valid;
}

/**
 * Baut aus den Default-Wert-Feldern die default_split_config für die API und
 * entfernt die flachen default_value_*-Felder aus dem Payload.
 */
function collectGroupDefaults(form, data) {
  const method = form.querySelector('[name="default_split_method"]')?.value;
  Object.keys(data).forEach((key) => { if (key.startsWith('default_value_')) delete data[key]; });
  if (!method) return;
  data.default_split_method = method;
  const config = [];
  if (method === 'percentage' || method === 'shares') {
    form.querySelectorAll('.split-default-value').forEach((input) => {
      const raw = decimalString(input.value);
      if (!raw) return;
      const uid = Number(input.name.replace('default_value_', ''));
      config.push(method === 'shares' ? { user_id: uid, shares: Number(raw) } : { user_id: uid, percentage: raw });
    });
  }
  data.default_split_config = config;
}

function formatDateWhileTyping(value) {
  const placeholder = dateInputPlaceholder();
  const separator = placeholder.includes('/') ? '/' : placeholder.includes('.') ? '.' : '-';
  const digits = String(value || '').replace(/\D/g, '').slice(0, 8);
  if (placeholder.startsWith('YYYY')) {
    if (digits.length <= 4) return digits;
    if (digits.length <= 6) return `${digits.slice(0, 4)}${separator}${digits.slice(4)}`;
    return `${digits.slice(0, 4)}${separator}${digits.slice(4, 6)}${separator}${digits.slice(6)}`;
  }
  if (digits.length <= 2) return digits;
  if (digits.length <= 4) return `${digits.slice(0, 2)}${separator}${digits.slice(2)}`;
  return `${digits.slice(0, 2)}${separator}${digits.slice(2, 4)}${separator}${digits.slice(4)}`;
}

function collectSplitPayload(form) {
  const method = form.querySelector('[name="split_method"]')?.value || 'equal';
  const participants = [...form.querySelectorAll('input[name="participants"]:checked')].map((input) => Number(input.value));
  if (method === 'equal') return { participants, splits: [] };
  const splits = participants.map((userId) => {
    const value = decimalString(form.querySelector(`[name="split_value_${userId}"]`)?.value);
    if (method === 'percentage') return { user_id: userId, percentage: value };
    if (method === 'exact') return { user_id: userId, amount: value };
    return { user_id: userId, shares: Number(value) };
  });
  return { participants, splits };
}

function renderGroupMemberEditor(candidates = []) {
  if (!candidates.length) return '';
  return `
    <div class="form-field user-ms split-members" data-ms-name="group_members" role="group" aria-labelledby="split-members-label">
      <span class="form-label" id="split-members-label">${t('splitExpenses.members')}</span>
      <div class="user-ms__options">
      ${candidates.map((candidate) => {
        const key = candidate.source === 'contact' ? `contact:${candidate.contact_id}` : `user:${candidate.user_id}`;
        const locked = candidate.group_role === 'owner';
        const badge = candidate.source === 'contact' ? ` · ${t('nav.contacts')}` : '';
        const role = candidate.group_role === 'guest' ? ` · ${t('splitExpenses.roleGuest')}` : '';
        return participantChip({ ...candidate, display_name: `${candidate.display_name ?? ''}${badge}${role}` },
          candidate.in_group, 'group_members', key, locked ? ' disabled' : '');
      }).join('')}
      </div>
    </div>
  `;
}

async function syncEditedGroupMembers(group, form) {
  if (!group) return;
  const selected = new Set([...form.querySelectorAll('input[name="group_members"]:checked')].map((input) => input.value));
  const candidates = state.memberCandidates || [];
  const currentUserIds = new Set(state.groupMembers.map((member) => Number(member.user_id)));
  for (const candidate of candidates) {
    if (candidate.source === 'user') {
      const userId = Number(candidate.user_id);
      const selectedKey = `user:${userId}`;
      if (selected.has(selectedKey) && !currentUserIds.has(userId)) {
        await api.post(`/split-expenses/groups/${group.id}/members`, { user_id: userId, role: 'guest' });
      } else if (!selected.has(selectedKey) && currentUserIds.has(userId) && candidate.group_role !== 'owner') {
        await api.delete(`/split-expenses/groups/${group.id}/members/${userId}`);
      }
    } else if (candidate.source === 'contact') {
      const selectedKey = `contact:${candidate.contact_id}`;
      if (selected.has(selectedKey)) {
        await api.post(`/split-expenses/groups/${group.id}/members`, { contact_id: candidate.contact_id, role: 'guest' });
      }
    }
  }
}

async function openGroupModal(group = null) {
  if (readOnly()) return;
  const currency = state.meta?.default_currency || 'EUR';
  const isEdit = Boolean(group);
  // Kommen die Kandidaten erst, nachdem der Nutzer einen anderen Dialog
  // geoeffnet oder die Seite verlassen hat, geht dieser Dialog nicht mehr auf (#1997).
  const context = captureOpenContext();
  const candidates = isEdit ? await loadMemberCandidates() : [];
  if (!isModalContextCurrent(context)) return;
  openSharedModal({
    title: isEdit ? t('splitExpenses.editGroup') : t('splitExpenses.addGroup'),
    initialFocus: isEdit ? 'edit' : 'first-field',
    content: `
      <form id="split-group-form" class="split-form" novalidate>
        <label class="form-field"><span class="form-label">${t('splitExpenses.name')}${REQUIRED_MARK}</span><input class="form-input" name="name" required maxlength="200" value="${esc(group?.name || '')}"></label>
        <label class="form-field"><span class="form-label">${t('splitExpenses.description')}</span><textarea class="form-input" name="description" rows="3" maxlength="5000">${esc(group?.description || '')}</textarea></label>
        <label class="form-field"><span class="form-label">${t('splitExpenses.type')}</span><select class="form-input" name="type">${state.meta.group_types.map((type) => `<option value="${type}" ${type === group?.type ? 'selected' : ''}>${t(`splitExpenses.groupType.${type}`)}</option>`).join('')}</select></label>
        <label class="form-field"><span class="form-label">${t('splitExpenses.currency')}</span><select class="form-input" name="default_currency">${state.meta.currencies.map((c) => `<option value="${c}" ${c === (group?.default_currency || currency) ? 'selected' : ''}>${c}</option>`).join('')}</select></label>
        ${isEdit ? renderGroupMemberEditor(candidates) : ''}
        ${isEdit ? renderGroupDefaults(group) : ''}
        <div class="modal-panel__footer modal-panel__footer--plain">
          <button class="btn btn--secondary" type="button" id="split-cancel-group">${t('common.cancel')}</button>
          <button class="btn btn--primary" type="submit" id="split-save-group">${isEdit ? t('common.save') : t('common.add')}</button>
        </div>
      </form>
    `,
    onSave(panel) {
      panel.querySelector('#split-cancel-group')?.addEventListener('click', () => closeModal());
      panel.querySelector('[name="default_split_method"]')?.addEventListener('change', () => updateGroupDefaults(panel));
      panel.querySelectorAll('.split-default-value').forEach((input) => input.addEventListener('input', () => updateGroupDefaults(panel)));
      updateGroupDefaults(panel);
      panel.querySelector('#split-group-form')?.addEventListener('submit', async (e) => {
        e.preventDefault();
        if (readOnly()) return;
        // KEINE BROWSER-BLASEN (Critique R21): `novalidate`, die Regeln des
        // Markups melden sich am Feld (constraintErrors, components/modal.js).
        if (reportFieldErrors(constraintErrors(e.currentTarget))) return;
        if (!updateGroupDefaults(panel)) {
          const first = panel.querySelector('.split-default-value:not([hidden])');
          reportFieldErrors([[first, panel.querySelector('#split-default-hint')?.textContent || t('splitExpenses.defaultSplitInvalid')]]);
          return;
        }
        const form = panel.querySelector('#split-group-form');
        const data = Object.fromEntries(new FormData(form));
        collectGroupDefaults(form, data);
        const dialog = captureModalContext();
        if (isEdit) await api.patch(`/split-expenses/groups/${group.id}`, data);
        else await api.post('/split-expenses/groups', data);
        if (isEdit) await syncEditedGroupMembers(group, form);
        // Neue Gruppen sind aktiv - aus dem Archiv heraus angelegt bliebe die
        // Liste sonst leer, obwohl die Gruppe existiert.
        if (!isEdit) state.groupStatus = 'active';
        // Nur diesen Dialog schliessen, nicht einen, der waehrend der Anfrage
        // aufgegangen ist; den Fokus nur zurueck, wenn er es war (#1997).
        const ownDialog = isOwnModalOpen(dialog);
        closeModal({ force: true, context: dialog });
        await loadGroups();
        await loadGroupData();
        renderAll();
        if (ownDialog) refocusAfterRender();
      });
    },
  });
}

/**
 * Die Zeilen der Leseansicht einer Ausgabe (#1265 P7): was der
 * Bearbeiten-Dialog zeigt - Betrag, Zahler, Datum, die Aufteilung samt Anteil
 * jeder Person, Notizen und Belege. Die Belege gehoeren dem Dokumente-Modul und
 * fragen dessen Recht (`attachmentLinksNode`); leere Zeilen fallen weg.
 */
function expenseReadSections(expense) {
  const method = expense.split_method || 'equal';
  const shares = (expense.splits || [])
    .map((split) => `${split.display_name || ''}: ${money(split.amount, split.currency || expense.currency)}`)
    .join('\n');
  return [
    { icon: 'banknote', label: t('splitExpenses.amount'), value: money(expense.amount, expense.currency) },
    { icon: 'user', label: t('splitExpenses.paidBy'), value: expense.payer_name || '' },
    { icon: 'calendar', label: t('splitExpenses.date'), value: expense.expense_date ? dateText(expense.expense_date) : '' },
    { icon: 'tag', label: t('splitExpenses.categoryLabel'), value: expense.budget_category ? categoryLabel(expense.budget_category) : '' },
    { icon: 'split', label: t('splitExpenses.splitMethod'),
      value: t(`splitExpenses.split${method.charAt(0).toUpperCase()}${method.slice(1)}`) },
    { icon: 'users', label: t('splitExpenses.participants'), value: shares, multiline: true },
    { icon: 'sticky-note', label: t('splitExpenses.notes'), value: expense.description || '', multiline: true },
    { icon: 'receipt', label: t('splitExpenses.receiptsLabel'), node: attachmentLinksNode(expense.attachments) },
  ];
}

/**
 * DER TIPP AUF EINE AUSGABE OEFFNET DAS LESEBLATT (R24, E1; Critique
 * G4-Budget-P2-4). Bis R24 ging das Bearbeiten-Formular auf, Titel fokussiert -
 * am Telefon mit Tastatur ueber dem halben Blatt -, obwohl die Frage meist
 * "wer hat was bezahlt" ist. Jetzt dieselbe Leseansicht wie Buchung, Abo,
 * Inventar: Betrag, Zahler, Datum, Kategorie, Beteiligte, Belege, und im Fuss
 * EIN Primaerknopf "Bearbeiten" (withPrimaryEdit). Bei `budget: read` und im
 * Archiv dieselbe Ansicht ohne Fuss (P1-Muster).
 */
function openExpenseReadView(expense, { editable = false } = {}) {
  const actions = editable ? withPrimaryEdit([], {
    id: 'split-read-edit',
    label: t('common.edit'),
    onClick: async ({ close } = {}) => {
      await (close ?? closeDetailView)({ force: true });
      openExpenseModal(expense);
    },
  }) : [];
  return openDetailView({
    title: expense.title,
    key: `split-expense:${expense.id}`,
    size: 'sm',
    sections: expenseReadSections(expense),
    actions,
  });
}

function openExpenseModal(expense = null, prefill = null) {
  // Der Riegel steht VOR jeder Vorbereitung: der Anlegeweg (auch die Uebergabe
  // aus dem Budget) entfaellt, eine bestehende Ausgabe geht als Leseansicht auf.
  if (readOnly()) {
    if (expense?.id) openExpenseReadView(expense);
    return;
  }
  if (!state.activeGroupId) return openGroupModal();
  const group = state.groups.find((g) => g.id === state.activeGroupId);
  const isEdit = Boolean(expense && expense.id);
  // Eine Vorbelegung aus dem Budget (#1057) verhaelt sich wie eine NEUE Ausgabe,
  // deren Felder schon ausgefuellt sind - nicht wie eine bearbeitete.
  if (prefill && !isEdit) {
    expense = {
      title: prefill.title ?? '',
      amount: prefill.amount ?? '',
      currency: prefill.currency ?? group.default_currency,
      expense_date: prefill.date ?? null,
    };
  }
  // Neue Ausgaben starten mit der Standard-Aufteilung der Gruppe (#517),
  // bestehende mit ihrer eigenen gespeicherten Aufteilung.
  const method = isEdit ? (expense.split_method || 'equal') : (group.default_split_method || 'equal');
  // `null` heisst "Standard-Aufteilung der Gruppe". Eine Vorbelegung aus dem
  // Budget nennt dagegen genau die Zustaendigen (#1057) - aber nur die, die
  // auch in DIESER Gruppe sind: eine Person, die im Haushalt zustaendig ist,
  // aber nicht zur Gruppe gehoert, kann hier nichts tragen. Bleibt davon
  // niemand uebrig, faellt es auf die Standard-Aufteilung zurueck statt auf
  // eine Ausgabe ohne Beteiligte.
  const prefilledIds = prefill?.participantIds?.length
    ? prefill.participantIds.filter((id) => state.groupMembers.some((m) => Number(m.id ?? m.user_id) === Number(id)))
    : [];
  const selectedIds = isEdit
    ? (expense.splits || []).map((s) => s.user_id)
    : (prefilledIds.length ? prefilledIds : null);
  const splitValues = isEdit ? deriveSplitValues(expense) : defaultSplitValues(group);
  // Der vorbelegte Tag ist „heute" und geht deshalb nach der Anzeigezone - aus
  // der Browser-Uhr gebaut trug eine neue Ausgabe abends in einer anderen Zone
  // den Nachbartag (#829, Nachlese #851).
  const today = todayKey();
  const methodOption = (value, label) => `<option value="${value}" ${value === method ? 'selected' : ''}>${label}</option>`;
  const currency = expense?.currency || group.default_currency;
  /* EIN GERUEST FUER JEDES GELD (Critique R24 G4-Budget-P1-1, D1 + D8): wie
   * die Buchung beginnt die Ausgabe mit dem Betrag, die Waehrung als Wahl im
   * Suffix (amountFieldHtml) statt als eigenes Feld; dann Titel, Datum und
   * Zahler in einer Zeile, Aufteilung und Kategorie, die Beteiligten als
   * Personen-Chips. Notiz und Belege stehen hinter "Weitere Angaben" und
   * nennen sich dort; beim Bearbeiten offen, sobald eines davon einen Wert
   * hat. Bearbeiten holt am Finger keine Tastatur (initialFocus 'edit'). */
  openSharedModal({
    staged: !isEdit, // Buehne zuerst, Felder nach dem ersten Bild (modal.js, R21 a6)
    title: isEdit ? t('splitExpenses.editExpense') : t('splitExpenses.addExpense'),
    initialFocus: isEdit ? 'edit' : 'first-field',
    content: `
      <form id="split-expense-form" class="split-form" novalidate>
        <div class="form-field">
          <label class="form-label" for="split-amount">${t('splitExpenses.amount')}${REQUIRED_MARK}</label>
          ${amountFieldHtml({ id: 'split-amount', name: 'amount', currency, value: expense?.amount || '', currencies: state.meta.currencies, describedBy: 'split-amount-reason' })}
        </div>
        <p class="form-hint form-hint--danger" id="split-amount-reason" role="status" hidden></p>
        <label class="form-field"><span class="form-label">${t('splitExpenses.titleLabel')}${REQUIRED_MARK}</span><input class="form-input" name="title" required maxlength="200" value="${esc(expense?.title || '')}"></label>
        <div class="split-form-row">
          <label class="form-field"><span class="form-label">${t('splitExpenses.date')}</span><yuvomi-datepicker name="expense_date" type="date" value="${esc(expense?.expense_date || today)}"></yuvomi-datepicker></label>
          <label class="form-field"><span class="form-label">${t('splitExpenses.paidBy')}</span><select class="form-input" name="payer_id">${memberOptions(isEdit ? expense.payer_id : state.user?.id)}</select></label>
        </div>
        <div class="split-form-row">
          <label class="form-field"><span class="form-label">${t('splitExpenses.splitMethod')}</span><select class="form-input" name="split_method">
            ${methodOption('equal', t('splitExpenses.splitEqual'))}
            ${methodOption('percentage', t('splitExpenses.splitPercentage'))}
            ${methodOption('exact', t('splitExpenses.splitExact'))}
            ${methodOption('shares', t('splitExpenses.splitShares'))}
          </select></label>
          <label class="form-field"><span class="form-label">${t('splitExpenses.categoryLabel')}</span><select class="form-input" name="budget_category">${categoryOptions(expense?.budget_category ?? null)}</select></label>
        </div>
        ${groupMemberCheckboxes(selectedIds, splitValues)}
        <p class="form-hint" id="split-method-hint">${t(`splitExpenses.splitHint.${method}`)}</p>
        ${advancedSection(`
        <label class="form-field"><span class="form-label">${t('splitExpenses.notes')}</span><textarea class="form-input" name="description" rows="3" maxlength="5000">${esc(expense?.description || '')}</textarea></label>
        ${renderDocumentAttachField({
          attachments: isEdit ? (expense.attachments || []) : [],
          label: t('splitExpenses.receiptsLabel'),
          hint: t('splitExpenses.receiptsHint'),
          icon: 'receipt',
        })}`, {
          hint: t('splitExpenses.moreDetailsHint'),
          open: isEdit && (Boolean(expense.description) || (expense.attachments?.length ?? 0) > 0),
        })}
        <div class="modal-panel__footer modal-panel__footer--plain">
          ${isEdit ? `<button class="btn btn--danger-outline" type="button" id="split-delete-expense">
            <i data-lucide="trash-2" class="icon-md" aria-hidden="true"></i>${t('common.delete')}
          </button>` : ''}
          <div class="split-form__footer-actions">
            <button class="btn btn--secondary" type="button" id="split-cancel-expense">${t('common.cancel')}</button>
            <button class="btn btn--primary" type="submit" id="split-save-expense">${isEdit ? t('common.save') : t('common.add')}</button>
          </div>
        </div>
      </form>
    `,
    onSave(panel) {
      // Belege (#583): landen als Dokumente im Dokumente-Modul, benannt nach der
      // Ausgabe - ein Kassenbon soll dort auffindbar bleiben.
      const receipts = bindDocumentAttachField(panel, {
        category: 'finance',
        folderKey: 'splitExpenses',
        folderName: t('documents.splitExpensesFolder'),
        documentName: (file) => t('splitExpenses.receiptDocumentName', {
          title: panel.querySelector('[name="title"]').value.trim() || file.name,
          group: group?.name || '',
        }),
      });
      panel.querySelector('#split-cancel-expense')?.addEventListener('click', () => closeModal());
      wireSplitFields(panel, '#split-expense-form');
      panel.querySelector('#split-delete-expense')?.addEventListener('click', async () => {
        if (readOnly()) return;
        // RUECKGAENGIG STATT RUECKFRAGE (Critique R23, D6): eine Ausgabe ist
        // kein Behaelter. Sie geht sofort aus der Liste, geloescht wird erst mit
        // dem Ende der Toast-Frist - bis dahin rechnen die Salden mit ihr.
        closeModal({ force: true, context: captureModalContext() });
        const id = expense.id;
        pendingExpenseDeletes.add(id);
        state.expenses = state.expenses.filter((entry) => entry.id !== id);
        await collapseSplitRow(`expense-${id}`);
        renderAll({ motion: true });
        refocusAfterRender();
        scheduleUndoableDelete({
          commit: async ({ keepalive } = {}) => {
            await api.delete(`/split-expenses/expenses/${id}`, { keepalive });
            pendingExpenseDeletes.delete(id);
            await refreshDashboard();
            await loadGroupData();
            renderAll({ motion: true });
            refocusAfterRender();
          },
          restore: async (err) => {
            pendingExpenseDeletes.delete(id);
            if (err) window.yuvomi?.showToast(errorSentence(err), 'danger');
            await loadGroupData();
            renderAll({ motion: true });
            refocusAfterRender();
          },
          message: expense.title ? t('common.deletedNamed', { name: expense.title }) : t('splitExpenses.expenseDeleted'),
        });
      });
      panel.querySelector('#split-expense-form')?.addEventListener('submit', async (e) => {
        e.preventDefault();
        if (readOnly()) return;
        // KEINE BROWSER-BLASEN (Critique R21): `novalidate`, die Regeln des
        // Markups melden sich am Feld (constraintErrors, components/modal.js).
        if (reportFieldErrors(constraintErrors(e.currentTarget))) return;
        if (reportSplitProblem(panel)) return;
        const form = panel.querySelector('#split-expense-form');
        const data = Object.fromEntries(new FormData(form));
        data.amount = decimalString(data.amount);
        const expenseCurrency = form.querySelector('[name="currency"]')?.value || group.default_currency;
        if (rejectSplitAmounts(form, expenseCurrency,
          { original: isEdit ? expense.amount : null, originalCurrency: isEdit ? expense.currency : null })) return;
        const { participants, splits } = collectSplitPayload(form);
        const payload = { ...data, participants, splits };
        const dialog = captureModalContext();
        // commit() lädt wartende Dateien erst jetzt hoch: ein abgebrochenes
        // Formular hinterlässt keine verwaiste Datei im Dokumente-Modul.
        if (receipts) payload.attachment_document_ids = await receipts.commit();
        if (isEdit) await api.put(`/split-expenses/expenses/${expense.id}`, payload);
        else await api.post(`/split-expenses/groups/${state.activeGroupId}/expenses`, payload);
        // Nur diesen Dialog schliessen, nicht einen, der waehrend der Anfrage
        // aufgegangen ist; den Fokus nur zurueck, wenn er es war (#1997).
        const ownDialog = isOwnModalOpen(dialog);
        closeModal({ force: true, context: dialog });
        await refreshDashboard();
        await loadGroupData();
        renderAll({ motion: true });
        if (ownDialog) refocusAfterRender();
      });
    },
  });
}

/**
 * Die Verdrahtung der Felder, die Ausgabe und Serie teilen: Aufteilungsart,
 * Waehrung, Betrag und die Beteiligten mit ihrem Wert. EINE Fassung fuer beide
 * Dialoge (#1647) - die Serie bekommt dieselbe Pruefung beim Tippen wie die
 * Ausgabe, statt einer Abschrift, die ihr nachlaeuft.
 */
function wireSplitFields(panel, formSelector) {
  panel.querySelector('[name="split_method"]')?.addEventListener('change', () => updateSplitInputs(panel));
  panel.querySelector('[name="currency"]')?.addEventListener('change', () => updateSplitInputs(panel));
  panel.querySelector(formSelector)?.addEventListener('input', () => validateSplitForm(panel));
  // Der Grund fuer einen gesperrten Betrag erscheint beim Verlassen des
  // Feldes, nicht bei jedem Tastendruck (syncAmountReason).
  panel.querySelector('[name="amount"]')?.addEventListener('change', () => validateSplitForm(panel, { reveal: true }));
  panel.querySelectorAll('input[name="participants"]').forEach((input) => {
    const row = input.closest('.split-participant-row');
    const valueInput = row?.querySelector('.split-split-value');
    if (valueInput) valueInput.disabled = !input.checked;
    input.addEventListener('change', () => {
      if (valueInput) valueInput.disabled = !input.checked;
      validateSplitForm(panel);
    });
  });
  updateSplitInputs(panel);
}

/**
 * Die Betraege eines Formulars vor dem Senden: der Betrag selbst und, bei
 * "exakt", jeder Anteil. Die Genau-Betraege sind Geld in derselben Waehrung.
 * Jeder Anteil eines angehakten Mitglieds muss groesser als 0 sein, auch wenn
 * die Summe stimmt ("-5 und 15"): der Server lehnt 0 und negative Anteile ab
 * (parseMoneyToMinor), und die Antwort kaeme englisch und ortlos zurueck. Wer
 * nichts traegt, wird abgehakt.
 *
 * @returns {boolean} true, wenn abgewiesen wurde (der Aufrufer bricht dann ab)
 */
function rejectSplitAmounts(form, currency, { original = null, originalCurrency = null } = {}) {
  if (rejectSplitAmount(form.querySelector('[name="amount"]'), currency, { original, originalCurrency, required: true })) return true;
  if (form.querySelector('[name="split_method"]')?.value !== 'exact') return false;
  for (const field of form.querySelectorAll('.split-split-value')) {
    if (field.hidden || field.disabled) continue;
    if (rejectSplitAmount(field, currency, { required: true })) return true;
  }
  return false;
}

/**
 * Die gespeicherte Aufteilung einer Serie als Feldwerte. Anders als eine
 * Ausgabe (`deriveSplitValues` rechnet aus gebuchten Anteilen zurueck) bewahrt
 * eine Serie ihre EINGABE auf - Betrag, Prozent oder Anteile je Person -, also
 * wird nichts rekonstruiert, nur in die Schreibweise der Region gesetzt.
 */
function recurringSplitValues(recurring) {
  const method = recurring.split_method;
  const values = {};
  for (const split of recurring.splits || []) {
    if (method === 'exact' && split.amount != null) values[split.user_id] = amountToInput(split.amount, recurring.currency);
    else if (method === 'percentage' && split.percentage != null) {
      const pct = Number(split.percentage);
      values[split.user_id] = Number.isFinite(pct) ? toStoredNumber(pct) : String(split.percentage);
    } else if (method === 'shares' && split.shares != null) values[split.user_id] = String(split.shares);
  }
  return values;
}

/** Zustand einer Serie in Worten: pausiert, und warum sie nicht bucht. Leer, wenn sie einfach laeuft. */
function recurringStateText(recurring) {
  return [
    recurring.paused_at ? t('splitExpenses.recurring.paused') : '',
    recurring.blocked_reason ? t(`splitExpenses.recurring.reason.${recurring.blocked_reason}`) : '',
    recurringIsFailing(recurring) ? t('splitExpenses.recurring.failing') : '',
  ].filter(Boolean).join(' · ');
}

/**
 * Ob der Lauf diese Serie unerwartet nicht buchen kann (#1746): `failed_at`
 * vom Server, an einer Serie, die laeuft. Eine pausierte wird nicht neu
 * versucht, also sagt sie es auch nicht.
 */
function recurringIsFailing(recurring) {
  return Boolean(recurring.failed_at) && !recurring.paused_at;
}

/** Das Zeichen zum Zustand: Pause, oder ein Warnzeichen fuer eine scheiternde, laufende Serie. */
function recurringStateIcon(recurring) {
  return recurring.paused_at || !recurringIsFailing(recurring) ? 'circle-pause' : 'alert-triangle';
}

/**
 * Die Zeilen der Leseansicht einer Serie - was der Bearbeiten-Dialog zeigt,
 * ohne Felder. Die Aufteilung steht als Eingabe da, wie die Serie sie fuehrt:
 * bei "gleich" nur die Namen, sonst Name und Wert.
 */
function recurringReadSections(recurring) {
  const method = recurring.split_method || 'equal';
  const names = new Map(state.groupMembers.map((m) => [Number(m.id ?? m.user_id), m.display_name]));
  const values = recurringSplitValues(recurring);
  const people = (recurring.participants || [])
    .map((id) => [names.get(Number(id)) || '', values[id]])
    .map(([name, value]) => (value != null && value !== '' ? `${name}: ${value}` : name))
    .filter(Boolean)
    .join('\n');
  return [
    { icon: 'banknote', label: t('splitExpenses.amount'), value: money(recurring.amount, recurring.currency) },
    { icon: 'user', label: t('splitExpenses.paidBy'), value: recurring.payer_name || '' },
    { icon: 'repeat', label: t('budget.recurringIntervalLabel'), value: frequencyLabel(recurring.frequency) },
    { icon: 'calendar', label: t('splitExpenses.recurring.nextDate'), value: recurring.paused_at ? '' : dateText(recurring.next_run_date) },
    { icon: recurringStateIcon(recurring), label: t('splitExpenses.statusLabel'), value: recurringStateText(recurring) },
    { icon: 'tag', label: t('splitExpenses.categoryLabel'), value: recurring.budget_category ? categoryLabel(recurring.budget_category) : '' },
    { icon: 'split', label: t('splitExpenses.splitMethod'),
      value: t(`splitExpenses.split${method.charAt(0).toUpperCase()}${method.slice(1)}`) },
    { icon: 'users', label: t('splitExpenses.participants'), value: people, multiline: true },
    { icon: 'sticky-note', label: t('splitExpenses.notes'), value: recurring.description || '', multiline: true },
  ];
}

function openRecurringReadView(recurring) {
  return openDetailView({
    title: recurring.title,
    size: 'sm',
    sections: recurringReadSections(recurring),
  });
}

/**
 * Wiederkehrende Ausgabe anlegen oder bearbeiten (#1647) - ein Dialog fuer
 * beides, mit den Feldern der Ausgabe und dazu Rhythmus und naechstem Termin.
 * Belege gibt es hier nicht: sie gehoeren zur einzelnen Buchung.
 *
 * Der Riegel steht VOR jeder Vorbereitung, wie in openExpenseModal(): ohne
 * Schreibrecht, im Archiv oder an einer Serie ohne `can_edit` geht eine
 * bestehende Serie als Leseansicht auf, und der Anlegeweg entfaellt.
 *
 * Geprueft wird am Server mit der Regel des Anlegens (`parseRecurringBody`);
 * hier laeuft dieselbe Formularpruefung wie bei der Ausgabe (wireSplitFields),
 * damit die Ablehnung am Feld steht statt englisch in einer Meldung.
 */
function openRecurringModal(recurring = null) {
  const isEdit = Boolean(recurring && recurring.id);
  if (isEdit ? !mayActOnRecurring(recurring) : (readOnly() || isArchivedView())) {
    if (isEdit) openRecurringReadView(recurring);
    return;
  }
  const group = state.groups.find((g) => g.id === state.activeGroupId);
  if (!group) return;
  const method = isEdit ? (recurring.split_method || 'equal') : (group.default_split_method || 'equal');
  const selectedIds = isEdit ? (recurring.participants || []) : null;
  const splitValues = isEdit ? recurringSplitValues(recurring) : defaultSplitValues(group);
  const currency = recurring?.currency || group.default_currency;
  const frequency = recurring?.frequency || 'monthly';
  const stateText = isEdit ? recurringStateText(recurring) : '';
  // Ein Zahler, der die Gruppe verlassen hat, steht nicht unter den
  // Mitgliedern. Ohne eigene Option zeigte das Feld das ERSTE Mitglied, und ein
  // Speichern, das nur den Titel meint, wechselte still den Zahler. Er bleibt
  // deshalb vorbelegt und gekennzeichnet, bis jemand bewusst einen anderen
  // waehlt - speichern laesst sich die Serie mit ihm nicht (siehe submit).
  const formerPayerId = isEdit && !state.groupMembers.some((m) => Number(m.id ?? m.user_id) === Number(recurring.payer_id))
    ? Number(recurring.payer_id)
    : null;
  const formerPayer = formerPayerId == null ? ''
    : `<option value="${formerPayerId}" selected>${esc(`${recurring.payer_name || ''} (${t('settings.memberFormerBadge')})`)}</option>`;
  const option = (value, label, selected) => `<option value="${value}" ${value === selected ? 'selected' : ''}>${label}</option>`;
  // Dasselbe Geldgeruest wie die Ausgabe (openExpenseModal): Betrag mit der
  // Waehrung im Suffix zuerst, dann Titel, Rhythmus und Termin, Zahler.
  openSharedModal({
    title: isEdit ? t('splitExpenses.recurring.edit') : t('splitExpenses.recurring.add'),
    initialFocus: isEdit ? 'edit' : 'first-field',
    content: `
      <form id="split-recurring-form" class="split-form" novalidate>
        ${stateText ? `<p class="form-hint field-hint--warn" role="status"><i data-lucide="${recurringStateIcon(recurring)}" aria-hidden="true"></i><span>${esc(stateText)}</span></p>` : ''}
        <div class="form-field">
          <label class="form-label" for="split-recurring-amount">${t('splitExpenses.amount')}${REQUIRED_MARK}</label>
          ${amountFieldHtml({ id: 'split-recurring-amount', name: 'amount', currency, value: recurring?.amount || '', currencies: state.meta.currencies, describedBy: 'split-amount-reason' })}
        </div>
        <p class="form-hint form-hint--danger" id="split-amount-reason" role="status" hidden></p>
        <label class="form-field"><span class="form-label">${t('splitExpenses.titleLabel')}${REQUIRED_MARK}</span><input class="form-input" name="title" required maxlength="200" value="${esc(recurring?.title || '')}"></label>
        <div class="split-form-row">
          <label class="form-field"><span class="form-label">${t('budget.recurringIntervalLabel')}</span><select class="form-input" name="frequency">
            ${['weekly', 'monthly', 'yearly'].map((f) => option(f, frequencyLabel(f), frequency)).join('')}
          </select></label>
          <label class="form-field"><span class="form-label">${t('splitExpenses.recurring.nextDate')}</span><yuvomi-datepicker name="next_run_date" type="date" value="${esc(recurring?.next_run_date || todayKey())}"></yuvomi-datepicker></label>
        </div>
        <div class="split-form-row">
          <label class="form-field"><span class="form-label">${t('splitExpenses.paidBy')}</span><select class="form-input" name="payer_id">${formerPayer}${memberOptions(isEdit ? recurring.payer_id : state.user?.id)}</select></label>
          <label class="form-field"><span class="form-label">${t('splitExpenses.categoryLabel')}</span><select class="form-input" name="budget_category">${categoryOptions(recurring?.budget_category ?? null)}</select></label>
        </div>
        <label class="form-field"><span class="form-label">${t('splitExpenses.splitMethod')}</span><select class="form-input" name="split_method">
          ${option('equal', t('splitExpenses.splitEqual'), method)}
          ${option('percentage', t('splitExpenses.splitPercentage'), method)}
          ${option('exact', t('splitExpenses.splitExact'), method)}
          ${option('shares', t('splitExpenses.splitShares'), method)}
        </select></label>
        ${groupMemberCheckboxes(selectedIds, splitValues)}
        <p class="form-hint" id="split-method-hint">${t(`splitExpenses.splitHint.${method}`)}</p>
        ${advancedSection(`
        <label class="form-field"><span class="form-label">${t('splitExpenses.notes')}</span><textarea class="form-input" name="description" rows="3" maxlength="5000">${esc(recurring?.description || '')}</textarea></label>`, {
          hint: t('splitExpenses.notes'),
          open: Boolean(recurring?.description),
        })}
        ${isEdit ? `<p class="form-hint">${t('splitExpenses.recurring.editHint')}</p>` : ''}
        <div class="modal-panel__footer modal-panel__footer--plain">
          ${isEdit ? `<button class="btn btn--danger-outline" type="button" id="split-delete-recurring">
            <i data-lucide="trash-2" class="icon-md" aria-hidden="true"></i>${t('common.delete')}
          </button>` : ''}
          <div class="split-form__footer-actions">
            <button class="btn btn--secondary" type="button" id="split-cancel-recurring">${t('common.cancel')}</button>
            <button class="btn btn--primary" type="submit" id="split-save-recurring">${isEdit ? t('common.save') : t('common.add')}</button>
          </div>
        </div>
      </form>
    `,
    onSave(panel) {
      panel.querySelector('#split-cancel-recurring')?.addEventListener('click', () => closeModal());
      wireSplitFields(panel, '#split-recurring-form');
      const form = panel.querySelector('#split-recurring-form');
      // Was der Dialog beim Oeffnen ZEIGT. Gesendet wird beim Bearbeiten nur,
      // was davon abweicht (changedRecurringFields).
      const shown = isEdit && form ? readRecurringForm(form) : null;
      // Rechte und Archiv koennen sich aendern, waehrend der Dialog offen
      // steht, und die Liste wird dabei neu geladen: gefragt wird deshalb die
      // Serie, wie sie JETZT in der Liste steht, nicht die von beim Oeffnen.
      const mayStillAct = () => (isEdit
        ? mayActOnRecurring(state.recurring.find((item) => item.id === recurring.id))
        : !readOnly() && !isArchivedView());
      // Ein zweites Absenden, waehrend das erste unterwegs ist (zweimal Enter),
      // legte eine zweite Serie an.
      let busy = false;
      panel.querySelector('#split-delete-recurring')?.addEventListener('click', async () => {
        if (readOnly()) return;
        if (!mayStillAct() || busy) return;
        const confirmed = await confirmOverModal(t('splitExpenses.recurring.deleteConfirm'), {
          danger: true,
          confirmLabel: t('common.delete'),
          detail: t('splitExpenses.recurring.deleteConfirmDetail'),
        });
        if (!confirmed || !mayStillAct() || busy) return;
        busy = true;
        try {
          await api.delete(`/split-expenses/recurring/${recurring.id}`);
        } finally {
          busy = false;
        }
        await loadGroupData();
        await collapseSplitRow(`recurring-${recurring.id}`);
        renderAll({ motion: true });
        refocusAfterRender();
      });
      form?.addEventListener('submit', async (e) => {
        e.preventDefault();
        if (readOnly()) return;
        if (!mayStillAct() || busy) return;
        // KEINE BROWSER-BLASEN (Critique R21): `novalidate`, die Regeln des
        // Markups melden sich am Feld (constraintErrors, components/modal.js).
        if (reportFieldErrors(constraintErrors(form))) return;
        if (reportSplitProblem(panel)) return;
        const chosenCurrency = form.querySelector('[name="currency"]')?.value || group.default_currency;
        if (rejectSplitAmounts(form, chosenCurrency,
          { original: isEdit ? recurring.amount : null, originalCurrency: isEdit ? recurring.currency : null })) return;
        const now = readRecurringForm(form);
        // Der ausgetretene Zahler steht noch im Feld: der Server wiese die
        // Serie ab (die ganze Serie wird geprueft), und zwar englisch und
        // ortlos. Der Grund steht deshalb hier, am Feld, das ihn behebt.
        if (formerPayerId != null && Number(now.payer_id) === formerPayerId) {
          reportFieldError(form.querySelector('[name="payer_id"]'), t('splitExpenses.recurring.reason.not_a_member'));
          return;
        }
        const payload = isEdit ? changedRecurringFields(shown, now, recurring) : now;
        // Ein Termin vor heute fragt, bevor die Luecke gebucht wird (#1748).
        // Der Riegel steht auch waehrend der Frage; danach wird Recht und
        // Archiv neu gefragt wie beim Loeschen.
        busy = true;
        let missed;
        try {
          missed = await recurringPastDateChoice(now, payload, isEdit ? recurring : null);
        } finally {
          busy = false;
        }
        if (missed === null || !mayStillAct()) return;
        const sent = missed ? { ...payload, missed } : payload;
        const dialog = captureModalContext();
        busy = true;
        try {
          // Nichts geaendert: kein Aufruf, kein Verlaufseintrag "bearbeitet".
          if (isEdit && Object.keys(payload).length === 0) { /* nur schliessen */ }
          else if (isEdit) await api.put(`/split-expenses/recurring/${recurring.id}`, sent);
          else await api.post(`/split-expenses/groups/${state.activeGroupId}/recurring`, sent);
        } catch (err) {
          // Der Termin liegt nicht nach der letzten Buchung (der Server haelt
          // einen gebuchten Tag fest): der Satz dazu steht am Datumsfeld, der
          // Dialog bleibt offen.
          if (err?.data?.reason === 'next_run_not_after_last_booking') {
            reportFieldError(form.querySelector('[name="next_run_date"]'),
              t('splitExpenses.recurring.dateBooked', { date: dateText(err.data.last_booked) }));
            return;
          }
          throw err;
        } finally {
          busy = false;
        }
        // Nur diesen Dialog schliessen, nicht einen, der waehrend der Anfrage
        // aufgegangen ist; den Fokus nur zurueck, wenn er es war (#1997).
        const ownDialog = isOwnModalOpen(dialog);
        closeModal({ force: true, context: dialog });
        await loadGroupData();
        renderAll({ motion: true });
        if (ownDialog) refocusAfterRender();
      });
    },
  });
}

/** Das Serienformular als Aufruf-Koerper: nur die Felder der Route, in ihrer Schreibweise. */
function readRecurringForm(form) {
  const data = Object.fromEntries(new FormData(form));
  const { participants, splits } = collectSplitPayload(form);
  return {
    title: String(data.title ?? ''),
    amount: decimalString(data.amount),
    currency: data.currency,
    payer_id: data.payer_id,
    frequency: data.frequency,
    next_run_date: data.next_run_date,
    split_method: data.split_method || 'equal',
    budget_category: data.budget_category || null,
    description: String(data.description ?? ''),
    participants,
    splits,
  };
}

/**
 * Was ein Bearbeiten sendet: NUR, was der Nutzer gegenueber dem beim Oeffnen
 * gezeigten Stand geaendert hat. Der Server laesst jedes weggelassene Feld
 * stehen (PUT /recurring/:id ist ein Teil-Update).
 *
 * Der Grund ist der Termin: der Dialog zeigt `next_run_date` vom Laden der
 * Liste. Bucht der Lauf inzwischen und rueckt die Serie weiter, schickte ein
 * Speichern, das nur den Titel meint, den alten Termin zurueck - eine
 * Verlegung, die niemand wollte, auf einen Tag, der schon gebucht ist. Dasselbe
 * gilt fuer jedes andere Feld, das ein Zweiter inzwischen geaendert hat.
 *
 * Zusammen reisen, was nur zusammen gilt: Betrag und Waehrung (der Betrag wird
 * im Raster seiner Waehrung gelesen), und Aufteilungsart, Beteiligte und Werte.
 *
 * Die Beteiligten messen sich an der GESPEICHERTEN Serie, nicht am Formular:
 * wer die Gruppe verlassen hat, hat dort kein Haekchen mehr. Der Dialog zeigt
 * die Serie dann schon ohne ihn, und Speichern schreibt, was er zeigt - das ist
 * die Reparatur einer Serie, die deshalb nicht bucht.
 */
function changedRecurringFields(shown, now, recurring) {
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const ids = (list) => (list || []).map(Number).sort((a, b) => a - b);
  const out = {};
  for (const key of ['title', 'payer_id', 'frequency', 'next_run_date', 'budget_category', 'description']) {
    if (!same(shown[key], now[key])) out[key] = now[key];
  }
  if (!same(shown.amount, now.amount) || !same(shown.currency, now.currency)) {
    out.amount = now.amount;
    out.currency = now.currency;
  }
  if (!same(shown.split_method, now.split_method) || !same(shown.splits, now.splits)
    || !same(ids(recurring.participants), ids(now.participants))) {
    out.split_method = now.split_method;
    out.participants = now.participants;
    out.splits = now.splits;
  }
  return out;
}

function openSettlementModal() {
  if (readOnly()) return;
  const group = state.groups.find((g) => g.id === state.activeGroupId);
  // Vorbefüllung aus der offenen Schuld: bevorzugt die, in der ich selbst der
  // Schuldner bin - statt Zahler=Empfänger=erstes Mitglied und leerem Betrag.
  const debts = state.balances.simplified_debts || [];
  const debt = debts.find((d) => String(d.from_user_id) === String(state.user?.id)) || debts[0] || null;
  openSharedModal({
    title: t('splitExpenses.registerPayment'),
    content: `
      <form id="split-settlement-form" class="split-form" novalidate>
        <div class="split-form-row">
          <label class="form-field"><span class="form-label">${t('splitExpenses.payer')}</span><select class="form-input" name="payer_id">${memberOptions(debt?.from_user_id ?? state.user?.id)}</select></label>
          <label class="form-field"><span class="form-label">${t('splitExpenses.payee')}</span><select class="form-input" name="payee_id">${memberOptions(debt?.to_user_id)}</select></label>
        </div>
        <p class="form-hint field-hint--warn" id="split-settlement-same" role="status" hidden><i data-lucide="alert-triangle" aria-hidden="true"></i><span>${t('splitExpenses.settlementSamePerson')}</span></p>
        <div class="split-form-row">
          <label class="form-field"><span class="form-label">${t('splitExpenses.amount')}${REQUIRED_MARK}</span><input class="form-input budget-amount-input" name="amount" inputmode="decimal" placeholder="${amountPlaceholder(debt?.currency || group.default_currency)}" required value="${debt ? esc(amountToInput(debt.amount, debt.currency)) : ''}"></label>
          <label class="form-field"><span class="form-label">${t('splitExpenses.currency')}</span><select class="form-input" name="currency">${state.meta.currencies.map((c) => `<option value="${c}" ${c === (debt?.currency || group.default_currency) ? 'selected' : ''}>${c}</option>`).join('')}</select></label>
        </div>
        <label class="form-field"><span class="form-label">${t('splitExpenses.notes')}</span><textarea class="form-input" name="notes" rows="3" maxlength="5000"></textarea></label>
        ${renderDocumentAttachField({
          label: t('splitExpenses.proofLabel'),
          hint: t('splitExpenses.proofHint'),
          icon: 'receipt',
          maxItems: 1,
        })}
        <div class="modal-panel__footer modal-panel__footer--plain">
          <button class="btn btn--secondary" type="button" id="split-cancel-settlement">${t('common.cancel')}</button>
          <button class="btn btn--primary" type="submit" id="split-save-settlement">${t('splitExpenses.registerPayment')}</button>
        </div>
      </form>
    `,
    onSave(panel) {
      // Zahlungsnachweis: das Modell kennt genau ein Dokument je Zahlung
      // (settlements.proof_document_id), deshalb wird unten nur das erste
      // übernommen - mehrere Nachweise für eine Überweisung gibt es nicht.
      const proof = bindDocumentAttachField(panel, {
        category: 'finance',
        folderKey: 'splitExpenses',
        folderName: t('documents.splitExpensesFolder'),
        documentName: (file) => t('splitExpenses.proofDocumentName', {
          group: group?.name || '',
          name: file.name,
        }),
      });
      const form = panel.querySelector('#split-settlement-form');
      const payerSel = form.querySelector('[name="payer_id"]');
      const payeeSel = form.querySelector('[name="payee_id"]');
      const sameHint = panel.querySelector('#split-settlement-same');
      const samePerson = () => payerSel.value === payeeSel.value;
      const syncSameHint = () => { sameHint.hidden = !samePerson(); };
      // Zahlerwechsel: passende Schuld dieses Zahlers übernehmen, solange der
      // Betrag noch unberührt ist; mindestens den Empfänger-Konflikt auflösen.
      payerSel.addEventListener('change', () => {
        const match = (state.balances.simplified_debts || []).find((d) => String(d.from_user_id) === payerSel.value);
        if (match) {
          payeeSel.value = String(match.to_user_id);
          const amountInput = form.querySelector('[name="amount"]');
          if (!amountInput.value || (debt && amountInput.value === amountToInput(debt.amount, debt.currency))) {
            amountInput.value = amountToInput(match.amount, match.currency);
          }
        }
        syncSameHint();
      });
      payeeSel.addEventListener('change', syncSameHint);
      syncSameHint();
      // Der Platzhalter zeigt die Null im Format der gewählten Währung und muss
      // beim Wechsel mitgehen - JPY schreibt "0", EUR "0,00".
      const currencySel = form.querySelector('[name="currency"]');
      currencySel?.addEventListener('change', () => {
        form.querySelector('[name="amount"]').placeholder = amountPlaceholder(currencySel.value);
      });
      panel.querySelector('#split-cancel-settlement')?.addEventListener('click', () => closeModal());
      form?.addEventListener('submit', async (e) => {
        e.preventDefault();
        if (readOnly()) return;
        if (samePerson()) { syncSameHint(); payeeSel.focus(); return; }
        // KEINE BROWSER-BLASEN (Critique R21): `novalidate`, die Regeln des
        // Markups melden sich am Feld (constraintErrors, components/modal.js).
        if (reportFieldErrors(constraintErrors(form))) return;
        const data = Object.fromEntries(new FormData(form));
        data.amount = decimalString(data.amount);
        if (rejectSplitAmount(form.querySelector('[name="amount"]'),
          form.querySelector('[name="currency"]')?.value || group.default_currency,
          { original: debt?.amount ?? null, originalCurrency: debt?.currency ?? null, required: true })) return;
        const dialog = captureModalContext();
        const proofIds = proof ? await proof.commit() : [];
        if (proofIds.length) data.proof_document_id = proofIds[0];
        await api.post(`/split-expenses/groups/${state.activeGroupId}/settlements`, data);
        // Nur diesen Dialog schliessen, nicht einen, der waehrend der Anfrage
        // aufgegangen ist; den Fokus nur zurueck, wenn er es war (#1997).
        const ownDialog = isOwnModalOpen(dialog);
        closeModal({ force: true, context: dialog });
        await refreshDashboard();
        await loadGroupData();
        renderAll();
        if (ownDialog) refocusAfterRender();
      });
    },
  });
}

async function openMemberModal() {
  if (readOnly()) return;
  // Kommen die Kandidaten erst, nachdem der Nutzer einen anderen Dialog
  // geoeffnet oder die Seite verlassen hat, geht dieser Dialog nicht mehr auf (#1997).
  const context = captureOpenContext();
  const candidates = await loadMemberCandidates();
  if (!isModalContextCurrent(context)) return;
  openSharedModal({
    title: t('splitExpenses.addMember'),
    content: `
      <form id="split-member-form" class="split-form" novalidate>
        <label class="form-field"><span class="form-label">${t('splitExpenses.member')}</span><select class="form-input" name="member_ref">${memberCandidateOptions(candidates)}</select></label>
        <label class="form-field"><span class="form-label">${t('splitExpenses.role')}</span><select class="form-input" name="role"><option value="guest">${t('splitExpenses.roleGuest')}</option><option value="admin">${t('splitExpenses.roleAdmin')}</option></select></label>
        <div class="modal-panel__footer modal-panel__footer--plain">
          <button class="btn btn--secondary modal-panel__footer-start" type="button" id="split-new-guest">${t('splitExpenses.createGuest')}</button>
          <div class="split-form__footer-actions">
            <button class="btn btn--secondary" type="button" id="split-cancel-member">${t('common.cancel')}</button>
            <button class="btn btn--primary" type="submit" id="split-save-member">${t('common.add')}</button>
          </div>
        </div>
      </form>
    `,
    onSave(panel) {
      panel.querySelector('#split-cancel-member')?.addEventListener('click', () => closeModal());
      panel.querySelector('#split-new-guest')?.addEventListener('click', () => openGuestModal());
      panel.querySelector('#split-member-form')?.addEventListener('submit', async (e) => {
        e.preventDefault();
        if (readOnly()) return;
        // KEINE BROWSER-BLASEN (Critique R21): `novalidate`, die Regeln des
        // Markups melden sich am Feld (constraintErrors, components/modal.js).
        if (reportFieldErrors(constraintErrors(e.currentTarget))) return;
        const data = Object.fromEntries(new FormData(panel.querySelector('#split-member-form')));
        const [source, id] = String(data.member_ref || '').split(':');
        delete data.member_ref;
        if (source === 'contact') data.contact_id = Number(id);
        else data.user_id = Number(id);
        const dialog = captureModalContext();
        await api.post(`/split-expenses/groups/${state.activeGroupId}/members`, data);
        // Nur diesen Dialog schliessen, nicht einen, der waehrend der Anfrage
        // aufgegangen ist; den Fokus nur zurueck, wenn er es war (#1997).
        const ownDialog = isOwnModalOpen(dialog);
        closeModal({ force: true, context: dialog });
        await loadGroups();
        await loadGroupData();
        renderAll();
        if (ownDialog) refocusAfterRender();
      });
    },
  });
}

function openGuestModal() {
  if (readOnly()) return;
  openSharedModal({
    title: t('splitExpenses.createGuest'),
    content: `
      <form id="split-guest-form" class="split-form" novalidate>
        <label class="form-field"><span class="form-label">${t('splitExpenses.displayName')}${REQUIRED_MARK}</span><input class="form-input" name="display_name" required maxlength="128"></label>
        <label class="form-field"><span class="form-label">${t('splitExpenses.usernameOptional')}</span><input class="form-input" name="username" autocomplete="off" maxlength="64"></label>
        <label class="form-field"><span class="form-label">${t('splitExpenses.temporaryPassword')}${REQUIRED_MARK}</span><input class="form-input" name="password" type="password" minlength="8" required autocomplete="new-password"></label>
        <div class="split-form-row">
          <label class="form-field"><span class="form-label">${t('splitExpenses.phone')}</span><input class="form-input" name="phone" type="tel" autocomplete="tel"></label>
          <label class="form-field"><span class="form-label">${t('splitExpenses.email')}</span><input class="form-input" name="email" type="email" autocomplete="email"></label>
        </div>
        <label class="form-field"><span class="form-label">${t('splitExpenses.birthDate')}</span><input class="form-input" name="birth_date" type="text" placeholder="${dateInputPlaceholder()}" inputmode="numeric"></label>
        <p class="form-hint">${t('splitExpenses.guestSyncHint')}</p>
        <div class="modal-panel__footer modal-panel__footer--plain">
          <button class="btn btn--secondary" type="button" id="split-cancel-guest">${t('common.cancel')}</button>
          <button class="btn btn--primary" type="submit" id="split-save-guest">${t('splitExpenses.createAndAddGuest')}</button>
        </div>
      </form>
    `,
    onSave(panel) {
      panel.querySelector('#split-cancel-guest')?.addEventListener('click', () => closeModal());
      const birthDateInput = panel.querySelector('[name="birth_date"]');
      birthDateInput?.addEventListener('input', () => {
        birthDateInput.value = formatDateWhileTyping(birthDateInput.value);
      });
      panel.querySelector('#split-guest-form')?.addEventListener('submit', async (e) => {
        e.preventDefault();
        if (readOnly()) return;
        // KEINE BROWSER-BLASEN (Critique R21): `novalidate`, die Regeln des
        // Markups melden sich am Feld (constraintErrors, components/modal.js).
        if (reportFieldErrors(constraintErrors(e.currentTarget))) return;
        const form = panel.querySelector('#split-guest-form');
        const birthDateRaw = form.querySelector('[name="birth_date"]')?.value || '';
        if (!isDateInputValid(birthDateRaw)) return;
        const data = Object.fromEntries(new FormData(form));
        data.birth_date = parseDateInput(birthDateRaw) || null;
        const dialog = captureModalContext();
        await api.post(`/split-expenses/groups/${state.activeGroupId}/guests`, data);
        // Nur diesen Dialog schliessen, nicht einen, der waehrend der Anfrage
        // aufgegangen ist; den Fokus nur zurueck, wenn er es war (#1997).
        const ownDialog = isOwnModalOpen(dialog);
        closeModal({ force: true, context: dialog });
        const [members, groupMembers] = await Promise.all([
          api.get('/family/members'),
          api.get(`/split-expenses/groups/${state.activeGroupId}/members`),
        ]);
        state.members = members.data || [];
        state.groupMembers = groupMembers.data || [];
        await loadGroups();
        await loadGroupData();
        renderAll();
        if (ownDialog) refocusAfterRender();
      });
    },
  });
}

/**
 * Messflaeche fuer die Nur-lesen-Regel (#1265 P7). `renderMain()` schreibt in
 * den Seitencontainer; der Griff laesst den echten Pfad laufen.
 */
export const __test = {
  readOnly, canAddSplitExpense, groupToolsMenuHtml, renderExpenses, state, expenseReadSections, openExpenseModal, groupMetaHtml, openGroupModal,
  renderActivity, onActivityClick, loadGroupData, loadMoreActivity, groupFromQuery,
  // Ausgabenliste seitenweise (#2108, test-split-activity-ui.js).
  onExpenseListClick, loadMoreExpenses,
  // Summen und Kategorien (#1888, #1941, test-split-totals-ui.js).
  renderMemberTotals, renderCategoryTotals, renderCategoryFilter, setCategoryFilter, readRecurringForm,
  // Betragseingabe (#1607): Formularpruefung und die beiden Speicherwege
  // (test-split-amount-input.js).
  validateSplitForm, updateGroupDefaults, openSettlementModal,
  // Wiederkehrende Ausgaben (#1647, test-split-recurring-ui.js).
  renderRecurring, onRecurringClick, toggleRecurring, openRecurringModal, recurringReadSections, recurringSplitValues, changedRecurringFields,
  renderMainForTest(container) { _container = container; renderMain(); },
  renderGroupsForTest(container) { _container = container; renderGroups(); },
  bindShellForTest(container) { _container = container; bindShell(); _statusTablist = null; },
  // #2119: der Kopf der Gruppenliste als echtes Markup (test-split-recurring-ui.js).
  groupsPanelHeadHtml,
  // R10 L11: die Gruppenzahl steht am Kopf der Liste (test-split-activity-ui.js).
  renderSummaryForTest(container) { _container = container; renderSummary(); },
  // R17/E5: der eigene Saldo der gewaehlten Gruppe und die Summe aller Gruppen.
  ownGroupBalance, groupToolsTriggerHtml,
  // R24 (Critique G4): eine Saldo-Aussage mit Namen, Leseblatt (E1), Absenden
  // ohne gesperrten Primaerknopf (test-split-totals-ui.js).
  foldedDebt, renderBalances, reportSplitProblem,
  // R22 D9: der Typ einer Gruppe faellt weg, wo er ihren Namen wiederholt.
  groupTypeLabel,
  // #1997: Mitglied und Gast speichern schliessen nur ihren eigenen Dialog
  // (test-split-amount-input.js).
  openMemberModal, openGuestModal,
  setContainerForTest(container) { _container = container; },
};
