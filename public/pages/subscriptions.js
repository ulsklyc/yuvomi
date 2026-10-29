/**
 * Module: Budget subscriptions
 * Purpose: Recurring subscription tracking, budgeting, analytics, and renewal reminders.
 */

import { api } from '/api.js';
import { closeModal, confirmModal, confirmOverModal, openModal, advancedSection, reportFieldError, reportFieldErrors, constraintErrors, refocusAfterRender, captureModalContext, captureOpenContext, isModalContextCurrent, isOwnModalOpen } from '/components/modal.js';
import {
  getLocale,
  getNumberFormat,
  isDateInputValid,
  parseDateInput,
  t,
} from '/i18n.js';
import { esc, REQUIRED_MARK } from '/utils/html.js';
import { isImeComposing, offerUndo, scheduleUndoableDelete } from '/utils/ux.js';
import { renderSkeletonList } from '/utils/skeleton.js';
import { emptyStateHTML, searchEmptyHTML, mountLoadError } from '/utils/empty-state.js';
import { todayKey } from '/utils/date.js';
import { dateText, percentText, daysFromTodayText } from '/utils/date-format.js';
import { COUNTDOWN_EXACT_DAYS } from '/utils/countdown.js';
import { CURRENCY_CODES } from '/utils/currency-codes.js';
import { wireSwipeRows, maybeShowSwipeHint } from '/utils/swipe-row.js';
import { redrawList, collapseRow } from '/utils/list-motion.js';
import { formatMoney, parseAmountInput } from '/utils/money.js';
import { amountFieldHtml, amountInputAttrs, setAmountCurrency, amountFieldError } from '/utils/amount-field.js';
import { mediaPickerBadgeHtml } from '/utils/media-picker.js';
import { attachOverlay } from '/utils/overlay-history.js';
import { inertOutside } from '/utils/background-inert.js';
import { isNavModuleReadOnly } from '/permissions.js';
import { openDetailView, closeDetailView, withPrimaryEdit } from '/components/detail-view.js';
import { rowActionHtml, rowMenuHtml } from '/utils/row-action.js';
import { installPopoverMenus } from '/utils/popover-menu.js';
import { sortableSet, restoreOrder } from '/utils/sortable.js';
import { renderPageSearch, wirePageSearch } from '/utils/page-search.js';
import { metricGlanceHtml, metricGlanceSkeletonHtml } from '/utils/metric-glance.js';
import { toggleRowHtml, formSwitchRowHtml } from '/settings/components.js';
import { fitMetricLeads } from '/utils/metric-card.js';
import { errorSentence, isGone, isAlreadyDeleted } from '/utils/friendly-error.js';
import { reloadAfterSave } from '/utils/reload-after-save.js';
import { colorPickerHtml, familyColorOptions, setColorPickerValue, wireColorPicker } from '/utils/color-picker.js';
import { intervalSentenceHtml, UNIT_SENTENCE_KEYS } from '/utils/interval-sentence.js';

const SUBSCRIPTION_COLOR_DEFAULT = '#0F766E';


let state = {
  subscriptions: [],
  summary: null,
  meta: { categories: [], payment_methods: [], billing_cycles: [] },
  settings: { monthly_budget: 0, base_currency: 'EUR' },
  rates: null,
  query: '',
  categoryId: '',
  paymentMethodId: '',
  status: 'all',
  sort: 'due',
  user: null,
};
let container = null;
/** Handle des geteilten Suchfelds (wirePageSearch) - Zuruecksetzen leert es mit. */
let searchField = null;

/**
 * KEIN AELTERER STAND UEBER EINEM NEUEREN (#1909, Codex an #2001). Jedes Laden
 * zieht eine Nummer und uebernimmt sein Ergebnis nur, wenn seither kein
 * neueres gestartet ist. Ein ueberholtes Laden wartet auf das neueste und
 * meldet dessen Ergebnis: wer danach zeichnet oder einen Dialog neu aufbaut,
 * tut das mit dem frischen Stand, nicht mit dem, der beim Ueberholen noch da
 * war (Review zu #2003).
 */
let loadTicket = 0;
let latestLoad = null;

/**
 * WEM EINE ANTWORT GEHOERT (#1909, Codex an #2001). Jeder Aufbau der Seite
 * (`render()`) ist eine eigene Instanz mit eigener Nummer. Eine Handlung haelt
 * ihre Instanz VOR dem Request fest (`pageOwner()`) und reicht sie durch: wer
 * sie erst nach der Antwort liest, bekommt nach "weg und zurueck" die NEUE
 * Seite, und eine spaete Antwort raeumte dort auf. Verglichen werden Nummer
 * und Knoten, und ob der Knoten noch im Dokument haengt - die Variable
 * `container` leert beim Verlassen niemand.
 */
let pageGeneration = 0;
function pageOwner() {
  return { el: container, gen: pageGeneration };
}
function isCurrentOwner(owner) {
  return Boolean(owner?.el) && container === owner.el && pageGeneration === owner.gen && owner.el.isConnected === true;
}

/**
 * Eine Pruefung der Seite selbst (Logo-Datei: Typ, Groesse, nicht lesbar):
 * traegt ihren schon uebersetzten Satz. Ein eigener Typ, damit die Fehlerstelle
 * ihn von einer Antwort des Servers unterscheidet, ohne den Text irgendeines
 * Fehlers zu lesen.
 */
class PageProblem extends Error {
  constructor(sentence) {
    super(sentence);
    this.name = 'PageProblem';
    this.sentence = sentence;
  }
}

/**
 * DER SATZ EINES FEHLERS IN DEN ABOS (#1909). Die eigene Pruefung sagt ihren
 * Satz; alles andere den Satz der App (`errorSentence`): den Fall, den der
 * Server mit `reason` nennt, sonst den allgemeinen der Stelle. Der Text des
 * Servers kommt nie an.
 */
function errorText(err, fallbackKey = 'common.unknownError') {
  if (err instanceof PageProblem) return err.sentence;
  return errorSentence(err, fallbackKey);
}

// Welche Gruende eine Kategorie oder Zahlungsart meinen, die es nicht mehr gibt.
const GONE_META = new Map([
  ['subscriptions_category_not_found', 'categoryId'],
  ['subscriptions_selected_category_not_found', 'categoryId'],
  ['subscriptions_payment_method_not_found', 'paymentMethodId'],
  ['subscriptions_selected_payment_method_not_found', 'paymentMethodId'],
]);

/**
 * Steht der Filter auf der Kategorie oder Zahlungsart, die es nicht mehr gibt,
 * geht er VOR dem Laden auf "alle" zurueck - sonst fragte das Laden mit der
 * geloeschten id und die Liste stuende leer unter einem toten Filter.
 *
 * @param {string} reason
 * @param {number|string|null|undefined} id - die id, die der Aufrufer kennt
 */
function resetGoneFilter(reason, id) {
  const filterKey = GONE_META.get(reason);
  if (!filterKey || id === null || id === undefined || id === '') return;
  if (state[filterKey] !== '' && Number(state[filterKey]) === Number(id)) {
    state[filterKey] = '';
    syncFilterSheet();
  }
}

/**
 * EIN WEG FUER DIE FEHLER-TOASTS DER SEITE (#1909). Sagt der Grund, dass es das
 * Ziel der Handlung nicht mehr gibt (ein anderes Haushaltsmitglied hat das Abo,
 * die Kategorie oder die Zahlungsart geloescht), laedt die Seite ueber das
 * normale Laden mit Ladenummer neu - Liste, Kennzahlen und Filter rechnet der
 * Server (Zuschnitt vom 15.10.: kein lokales Nachbauen). `owner` ist die
 * Seiteninstanz, VOR dem Request festgehalten. `dialog` ist der Modal-Kontext
 * der Handlung (`captureModalContext()` vor der Anfrage): geschlossen wird nur,
 * wenn genau dieser Dialog noch offen ist (Codex an #1994). `reopen` baut ihn
 * neu auf (Verwalten-Dialog), aber erst, wenn das neueste Laden angewandt ist.
 * Nach jedem await fragt die Seite, ob sie noch dieselbe ist.
 */
async function reportError(err, { fallbackKey = 'common.unknownError', owner = null, dialog = null, goneId = null, reopen = null } = {}) {
  window.yuvomi?.showToast(errorText(err, fallbackKey), 'danger');
  if (!isGone(err)) return;
  // Ohne die vor dem Request festgehaltene Instanz wird nichts nachgezogen.
  if (!isCurrentOwner(owner)) return;
  const wasOpen = Boolean(dialog) && isModalContextCurrent(dialog);
  if (wasOpen) await closeModal({ force: true });
  if (!isCurrentOwner(owner)) return;
  resetGoneFilter(err.data.reason, goneId);
  // Ein scheiterndes Laden meldet nichts weiter - der Satz steht schon da.
  if (!await reload(undefined, { owner, quiet: true })) return;
  refocusAfterRender();
  if (wasOpen && reopen) reopen();
}

const SELECTED_META_GONE = new Map([
  ['subscriptions_selected_category_not_found', 'subscription-category'],
  ['subscriptions_selected_payment_method_not_found', 'subscription-method'],
]);
const selectedMetaGone = (err) => (isGone(err) ? SELECTED_META_GONE.get(err.data.reason) : undefined);

// --------------------------------------------------------
// Nur-lesen (#467, #1265 P7)
// --------------------------------------------------------

/**
 * Darf dieser Nutzer Abos pflegen? Die Abos sind ein Budget-Reiter und liegen
 * unter `/budget/subscriptions`, also fragt die Seite dasselbe Modul wie
 * budget.js. Ohne diese Frage trug sie bei `budget: read` jeden Schreibweg:
 * anlegen, bearbeiten, verlaengern, loeschen (Knopf UND Wischgeste),
 * Kategorien und Zahlungsarten, Monatsbudget und Basiswaehrung.
 */
function readOnly() {
  return isNavModuleReadOnly('budget');
}

// Jede `data-action` dieser Seite, die NICHT schreibt: nur `view`, der Weg in
// die Leseansicht eines Abos. Eine Positivliste - eine morgen ergaenzte Aktion
// ist damit standardmaessig gesperrt statt standardmaessig offen.
const READ_SAFE_ACTIONS = new Set(['view']);

function setHtml(element, html) {
  element.replaceChildren();
  element.insertAdjacentHTML('afterbegin', html);
  // Leitzahl in fester Stufe, kleiner nur bei Ueberlauf (R23, D12).
  fitMetricLeads(element);
}

// Format aus utils/money.js - EINE Quelle für das ganze Budget-Modul. Vorher
// hatte jede der drei Page-Dateien einen eigenen Formatierer, sodass dieselbe
// Zahl in zwei Untertabs verschieden geschrieben sein konnte (Critique P0).
// Abo-Beträge tragen die Rolle `plain`: Rechnungsbeträge ohne Kontorichtung,
// also kein Vorzeichen und keine Ampelfarbe.
function money(amount, currency = state.summary?.base_currency || state.settings.base_currency) {
  return formatMoney(amount, currency);
}

// EINE ZEILE SAGT SELBST, WIE SIE HEISST. Vorher stand hier eine Karte von
// englischen Vorgabe-NAMEN auf i18n-Schluessel, und daneben - fuer die
// Zahlungsarten - gar nichts: dieselbe Liste stand halb uebersetzt da (#950).
// Eine Namenskarte kann auch nicht wissen, ob 'Other' die Vorgabe oder eine
// selbst angelegte Zeile desselben Namens meint. Seit Migration 170 tragen
// beide Tabellen `label_key`, wie task_categories, contact_categories und
// inventory_categories es laengst tun; Umbenennen loescht ihn, dann gilt der
// eigene Name. Der Rueckfall ist das leere Fach, nicht ein englisches Wort.
function metaLabel(item, emptyKey) {
  if (item?.label_key) return t(item.label_key);
  return item?.name || t(emptyKey);
}

function categoryLabel(category) {
  return metaLabel(category, 'subscriptions.uncategorized');
}

function paymentMethodLabel(method) {
  return metaLabel(method, 'subscriptions.unspecified');
}

// Ein Abo traegt Kategorie und Zahlungsart denormalisiert (JOIN in
// routes/subscriptions.js), also als zwei lose Felder statt als Zeile. Diese
// beiden setzen sie wieder zusammen, damit dieselbe Regel greift wie ueberall
// sonst - genau so macht es inventory.js mit `itemCategoryLabel`. Ohne sie
// laesst sich ein Aufrufer leicht mit dem nackten `*_name` abspeisen, und
// genau daran hing #950.
function rowCategoryLabel(row) {
  return categoryLabel({ name: row?.category_name, label_key: row?.category_label_key });
}

function rowPaymentMethodLabel(row) {
  return paymentMethodLabel({ name: row?.payment_method_name, label_key: row?.payment_method_label_key });
}

function addMonths(date, count) {
  const next = new Date(date);
  const day = next.getDate();
  next.setMonth(next.getMonth() + count, 1);
  const lastDay = new Date(next.getFullYear(), next.getMonth() + 1, 0).getDate();
  next.setDate(Math.min(day, lastDay));
  return next;
}

function addCycleDate(date, cycle, interval) {
  const next = new Date(date);
  if (cycle === 'daily') next.setDate(next.getDate() + interval);
  else if (cycle === 'weekly') next.setDate(next.getDate() + (interval * 7));
  else if (cycle === 'yearly') next.setFullYear(next.getFullYear() + interval);
  else return addMonths(next, interval);
  return next;
}

// Letztes einzuplanendes Fälligkeitsdatum bei begrenztem Abo (#594), sonst null.
// Für 'after_count' wird das Startdatum um die verbleibenden Zyklen fortgeschrieben.
function subscriptionEndBoundary(subscription) {
  if (subscription.end_type === 'on_date' && subscription.end_date) {
    return new Date(`${subscription.end_date}T00:00:00`);
  }
  if (subscription.end_type === 'after_count') {
    const remaining = Number(subscription.occurrence_count) - Number(subscription.occurrences_done || 0);
    if (remaining <= 0) return new Date(0);
    let last = new Date(`${subscription.next_payment_date}T00:00:00`);
    for (let index = 1; index < remaining; index += 1) {
      last = addCycleDate(last, subscription.billing_cycle, subscription.cycle_interval || 1);
    }
    return last;
  }
  return null;
}

function monthKey(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}

function monthLabel(key) {
  const [year, month] = key.split('-').map(Number);
  return new Intl.DateTimeFormat(getLocale(), { month: 'short' }).format(new Date(year, month - 1, 1));
}

// Die Zeile sagt denselben Satz wie der Dialog (R24 S4): "Alle 2 Monate" aus
// dem Satz der Einheit, mit der Pluralform der Zahl - "Co 2 miesiące" neben
// "Co 5 miesięcy". Bis dahin setzte sie ein festes Pluralwort ein
// (`subscriptions.cyclePlural`), das im Polnischen, Tschechischen, Russischen
// und Ukrainischen bei 2-4 falsch war. Bei 1 bleibt das Adverb ("Monatlich").
function cycleLabel(subscription) {
  const key = `subscriptions.cycle.${subscription.billing_cycle}`;
  const sentence = UNIT_SENTENCE_KEYS[subscription.billing_cycle];
  return subscription.cycle_interval === 1 || !sentence
    ? t(key)
    : t(sentence, { count: subscription.cycle_interval });
}

function daysUntil(date) {
  const today = new Date(`${todayKey()}T00:00:00`);
  const due = new Date(`${date}T00:00:00`);
  return Math.round((due - today) / 86400000);
}

function dueLabel(subscription) {
  const days = daysUntil(subscription.next_payment_date);
  if (days < 0) return t('subscriptions.overdueDays', { count: Math.abs(days) });
  if (days === 0) return t('subscriptions.dueToday');
  if (days === 1) return t('subscriptions.dueTomorrow');
  // UEBER EINEN MONAT DIE GROBE STUFE (R23 D11, Rest aus S7): "Faellig in
  // 140 Tagen" verlangte Kopfrechnen fuer eine Jahreszahlung. Wie jeder
  // Abstand in der App (utils/date-format.js): bis 30 Tage genau, dann
  // Wochen, Monate, Jahre - das Datum davor nennt den Tag.
  if (days > COUNTDOWN_EXACT_DAYS) return daysFromTodayText(days);
  return t('subscriptions.dueInDays', { count: days });
}

function load(options) {
  const run = loadOnce(options);
  latestLoad = run;
  return run;
}

async function loadOnce({ refreshRates = false } = {}) {
  const params = new URLSearchParams();
  if (state.query) params.set('q', state.query);
  if (state.categoryId) params.set('category_id', state.categoryId);
  if (state.paymentMethodId) params.set('payment_method_id', state.paymentMethodId);
  if (state.status !== 'all') params.set('status', state.status);
  if (refreshRates) params.set('refresh_rates', 'true');

  // Siehe loadTicket: ein ueberholtes Laden uebernimmt nichts, auch keinen
  // Fehler, und meldet das Ergebnis des neuesten (false, wenn das scheitert -
  // dessen Aufrufer sagt es dann).
  const ticket = ++loadTicket;
  const outdated = () => ticket !== loadTicket;
  const newest = () => latestLoad.then(() => true, () => false);
  let answers;
  try {
    answers = await Promise.all([
      api.get(`/budget/subscriptions?${params}`),
      api.get('/budget/subscriptions/meta'),
      api.get('/budget/subscriptions/settings'),
    ]);
  } catch (err) {
    if (outdated()) return newest();
    throw err;
  }
  if (outdated()) return newest();
  const [list, meta, settings] = answers;
  state.subscriptions = (list.data?.subscriptions || []).filter((entry) => !pendingDeletes.has(entry.id));
  state.summary = list.data?.summary || null;
  state.rates = list.data?.rates || null;
  state.meta = meta.data || state.meta;
  state.settings = settings.data || state.settings;
  return true;
}

export async function render(target, { user } = {}) {
  container = target;
  pageGeneration += 1;
  const owner = pageOwner();
  state.user = user || null;
  // `full`, nicht `reading`: die Seite ist nicht auf das Mass migriert. Ihr
  // Analytik-Raster (drei Spalten, zusammen mindestens 724px) und die Liste
  // kennen kein Lesemass; als `reading` haette nur das Kennzahlenband die
  // 720px angenommen und den Sprung zu den Diagrammen darunter erzeugt - als
  // Budget-Reiter wie als Gast-Route. Zielmodus ist `dashboard`, sobald
  // Werkzeugzeile, Raster und Liste dasselbe Mass lesen.
  setHtml(container, `
    <div class="subscriptions-page app-page app-page--full" data-composition="full" aria-busy="true">
      <!-- EINE WERKZEUGZEILE STATT VIER SELECTS (Critique 2026-09-25, P2).
           Hier standen Suche, vier beschriftete Selects, Zuruecksetzen und zwei
           Icon-Knoepfe - mobil 213px hoch, die erste Abo-Zeile bei y=1123.
           Die Zeile fuehrt jetzt die Grammatik der anderen Module: Suche,
           EIN Filterknopf mit der Zahl der aktiven Filter (Blatt wie im
           Kalender), EIN Werkzeug-Menue (Sortierung + Verwaltung wie in den
           Dokumenten und der Buchungsliste). Was gerade einschraenkt, steht
           darunter als abwaehlbarer Chip - nur dann, sonst kostet es nichts.

           IM KOPF DER LISTE, DIE SIE FILTERT (R14 P8, A5 P2-7): die Zeile
           stand als eigene Werkzeugzeile ueber allem, die Suche 448px breit
           und mobil als volles Feld. Jetzt ist sie der Abschnittskopf wie im
           Hauptbuch (.section-toolbar): Titel links, Suche mit
           --page-search-width, mobil in der Icon-Form. Kennzahlen stehen
           davor, damit Kopf und Liste zusammen bleiben; der Kopf wird nie neu
           gebaut, sonst verloere die Suche beim Tippen ihren Fokus.

           AUF DER BUEHNE, NICHT IN DER KARTE (R16 Schritt 2b, Reiter-Skelett
           des Budgets): der Kopf stand samt Titel IN der weissen Flaeche der
           Liste, waehrend "Transaktionen" und "Kategorie-Budgets" nebenan
           ueber ihrem Traeger stehen. Jetzt h2.u-section-title mit den
           Werkzeugen rechts, darunter der Zeilentraeger (.row-carrier). -->
      <div class="subscriptions-summary" id="subscriptions-summary">${/* Der Kennzahl-Slot steht ab dem ersten Bild in seiner Form (R22, D4). */ ''}${metricGlanceSkeletonHtml({ lead: true, controls: false, flows: 2, everywhere: true })}
      </div>
      <section class="subscriptions-list-section" aria-labelledby="subscriptions-list-title">
        <div class="subscriptions-section-head section-toolbar">
          <div class="subscriptions-section-head__lead">
            <h2 class="u-section-title" id="subscriptions-list-title" tabindex="-1">${t('subscriptions.listTitle')}</h2>
            <span class="list-group__count" id="subscriptions-list-count"></span>
          </div>
          <span class="subscriptions-rates-slot" id="subscriptions-rates-slot"></span>
          ${renderPageSearch({
    id: 'subscriptions-search',
    label: t('subscriptions.searchLabel'),
    placeholder: t('subscriptions.searchPlaceholder'),
    value: state.query,
    clearLabel: t('common.searchClear'),
    className: 'subscriptions-search',
  })}
          <button type="button" class="btn btn--secondary subscriptions-filter-btn" id="subscriptions-filters" aria-haspopup="dialog" aria-label="${esc(t('subscriptions.filters'))}">
            <i data-lucide="sliders-horizontal" class="icon-md" aria-hidden="true"></i>
            <span class="subscriptions-filter-btn__label">${t('subscriptions.filters')}</span>
            <span class="subscriptions-filter-btn__count" aria-hidden="true" hidden></span>
          </button>
          ${toolsMenuHtml()}
        </div>
        <div class="subscriptions-active-filters" id="subscriptions-active-filters" role="group" aria-label="${t('subscriptions.activeFiltersLabel')}" hidden></div>
        <div id="subscriptions-content">${renderSkeletonList({ rows: 5, lines: 2 })}</div>
      </section>
      <div id="subscriptions-analytics"></div>
    </div>
  `);
  if (window.lucide) window.lucide.createIcons({ el: container });
  try {
    // Ein Ergebnis, das nicht uebernommen wurde, oder eine Seite, die
    // inzwischen verlassen oder neu aufgebaut ist: nichts zeichnen, nichts
    // binden (Review zu #2003).
    if (!await load() || !isCurrentOwner(owner)) return;
    renderFilters();
    renderContent();
    bindToolbar();
  } catch (err) {
    console.error('[Subscriptions] load error:', err);
    // Vorher stand hier ein Leerzustands-Markup ohne Rolle und ohne CTA: der
    // Fehler war fuer Screenreader stumm und die Seite eine Sackgasse - neu
    // laden ging nur ueber den Browser. `mountLoadError` erzwingt beides.
    mountLoadError(container.querySelector('#subscriptions-content'), {
      title: t('subscriptions.loadError'),
      description: t('common.loadErrorDescription'),
      error: err,
      retryLabel: t('common.retry'),
      onRetry: () => render(container, { user: state.user }),
    });
  } finally {
    container.querySelector('.subscriptions-page')?.setAttribute('aria-busy', 'false');
    if (window.lucide) window.lucide.createIcons({ el: container });
  }
}

// Die drei Filter, die WEGNEHMEN, was man sieht. Die Sortierung gehoert nicht
// dazu (sie ordnet nur) und steht deshalb im Werkzeug-Menue, nicht im Blatt
// und nicht in der Chip-Zeile - dieselbe Trennung wie in den Dokumenten.
const STATUS_OPTIONS = [
  ['all', 'common.all'],
  ['active', 'subscriptions.statusActive'],
  ['paused', 'subscriptions.statusDisabled'],
  ['completed', 'subscriptions.completed'],
];
const SORT_OPTIONS = [
  ['due', 'subscriptions.sortDue'],
  ['cost-desc', 'subscriptions.sortCostDesc'],
  ['cost-asc', 'subscriptions.sortCostAsc'],
  ['name', 'subscriptions.sortName'],
];

/** Die gerade aktiven Filter als { key, field, value } - Quelle fuer Zahl und Chips. */
function activeFilters() {
  const out = [];
  if (state.categoryId) {
    const item = state.meta.categories.find((row) => String(row.id) === String(state.categoryId));
    out.push({ key: 'category', field: t('subscriptions.filterLabelCategory'), value: categoryLabel(item) });
  }
  if (state.paymentMethodId) {
    const item = state.meta.payment_methods.find((row) => String(row.id) === String(state.paymentMethodId));
    out.push({ key: 'method', field: t('subscriptions.filterLabelMethod'), value: paymentMethodLabel(item) });
  }
  if (state.status !== 'all') {
    const option = STATUS_OPTIONS.find(([id]) => id === state.status);
    out.push({ key: 'status', field: t('subscriptions.filterLabelStatus'), value: t(option?.[1] ?? 'common.all') });
  }
  return out;
}

/**
 * Filterknopf und Chip-Zeile nachziehen. Die Zeile erscheint NUR, wenn etwas
 * einschraenkt - ein leerer Streifen „keine Filter" waere Chrome ohne Auskunft.
 * Jeder Chip nimmt genau seinen Filter zurueck; ab zwei Filtern steht dahinter
 * „Filter zuruecksetzen" fuer alle auf einmal.
 */
function renderFilters() {
  const filters = activeFilters();
  const button = container.querySelector('#subscriptions-filters');
  if (button) {
    const count = button.querySelector('.subscriptions-filter-btn__count');
    button.classList.toggle('subscriptions-filter-btn--active', filters.length > 0);
    if (count) {
      count.hidden = filters.length === 0;
      count.textContent = String(filters.length);
    }
    // Der Name steht immer als aria-label: mobil faellt die Beschriftung weg
    // (Label-Verlust-Regel), der Knopf ist dann nur noch sein Icon.
    button.setAttribute('aria-label', filters.length ? t('subscriptions.filtersActive', { count: filters.length }) : t('subscriptions.filters'));
  }
  const row = container.querySelector('#subscriptions-active-filters');
  if (row) {
    row.hidden = filters.length === 0;
    setHtml(row, `
      ${filters.map((filter) => {
        const label = t('subscriptions.filterChip', { field: filter.field, value: filter.value });
        return `<button type="button" class="filter-chip filter-chip--sm filter-chip--active subscriptions-filter-chip"
                data-remove-filter="${filter.key}" aria-label="${esc(t('subscriptions.removeFilter', { label }))}">
          <span>${esc(label)}</span><i data-lucide="x" class="icon-sm" aria-hidden="true"></i>
        </button>`;
      }).join('')}
      ${filters.length > 1 ? `<button type="button" class="btn btn--ghost btn--sm subscriptions-filter-reset" id="subscriptions-reset-filters">${t('subscriptions.resetFilters')}</button>` : ''}
    `);
    if (window.lucide) window.lucide.createIcons({ el: row });
  }
  syncToolsMenu();
}

// Filter plus Suche koennen gleichzeitig greifen - ohne Ausweg wirkt eine
// leere Liste wie „keine Abos" statt „nichts passt zum Filter". Die Sortierung
// zaehlt nicht: sie nimmt nichts weg und kann keine Liste leeren.
function hasActiveFilters() {
  return Boolean(state.query) || activeFilters().length > 0;
}

/**
 * Nimmt Suche und Filter weg, OHNE zu zeichnen - fuer einen Aufrufer, der
 * gleich danach in diesen Reiter wechselt und dort ein bestimmtes Abo
 * erwartet (die erwartete Abo-Zeile der Budgetliste, #1844). Der Zustand lebt
 * im Modul und ueberdauert den Reiterwechsel: mit einem Filter aus einem
 * frueheren Besuch fuehrte die Zeile auf eine Liste, in der ihr Abo fehlt.
 * Die Sortierung bleibt, sie nimmt nichts weg.
 */
export function clearSubscriptionFilters() {
  state.query = '';
  state.categoryId = '';
  state.paymentMethodId = '';
  state.status = 'all';
}

async function resetFilters() {
  clearSubscriptionFilters();
  searchField?.clear();
  syncFilterSheet();
  await reload();
}

async function removeFilter(key) {
  if (key === 'category') state.categoryId = '';
  if (key === 'method') state.paymentMethodId = '';
  if (key === 'status') state.status = 'all';
  syncFilterSheet();
  await reload();
  // Der entfernte Chip ist weg - der Fokus faellt auf den naechsten Chip oder,
  // wenn keiner bleibt, zurueck auf den Filterknopf, nicht aufs Dokument.
  const next = container.querySelector('#subscriptions-active-filters [data-remove-filter]')
    ?? container.querySelector('#subscriptions-filters');
  next?.focus();
}

/**
 * Das Werkzeug-Menue der Abos (Muster: listToolsMenuHtml in budget.js,
 * documentsToolsMenuHtml): Sortierung als Einfachauswahl mit Haken, darunter
 * die beiden Verwaltungswege. Die Verwaltung schreibt und faellt bei
 * `budget: read` weg; die Sortierung liest und bleibt. Positionierung, Esc und
 * Pfeiltasten kommen vom geteilten popover-menu, das budget.js an der
 * Seitenwurzel verdrahtet (installPopoverMenus).
 */
function toolsMenuHtml() {
  const label = t('common.moreActions');
  const check = (on) => `<i data-lucide="check" class="icon-md popover-menu__item-check${on ? '' : ' popover-menu__item-check--hidden'}" aria-hidden="true"></i>`;
  return `
    <button type="button" class="btn btn--secondary btn--icon subscriptions-tools popover-menu__trigger"
            popovertarget="subscriptions-tools-menu" aria-haspopup="menu" aria-expanded="false"
            aria-label="${esc(label)}" title="${esc(label)}">
      <i data-lucide="ellipsis" class="icon-md" aria-hidden="true"></i>
    </button>
    <div class="popover-menu subscriptions-tools-menu" id="subscriptions-tools-menu" popover role="menu" aria-label="${esc(label)}">
      <div class="popover-menu__group" role="group" aria-labelledby="subscriptions-tools-sort-label">
        <div class="popover-menu__label" id="subscriptions-tools-sort-label">${esc(t('subscriptions.filterLabelSort'))}</div>
        ${SORT_OPTIONS.map(([id, key]) => {
          const on = state.sort === id;
          return `
        <button type="button" role="menuitemradio" aria-checked="${on}" class="popover-menu__item" data-sort="${id}">
          ${check(on)}<span>${esc(t(key))}</span>
        </button>`;
        }).join('')}
      </div>
      ${readOnly() ? '' : `<div class="popover-menu__separator" role="separator"></div>
      <button type="button" role="menuitem" class="popover-menu__item" id="subscriptions-manage">
        <i data-lucide="tags" class="icon-md" aria-hidden="true"></i><span>${esc(t('subscriptions.manageMetadata'))}</span>
      </button>
      <button type="button" role="menuitem" class="popover-menu__item" id="subscriptions-settings">
        <i data-lucide="settings-2" class="icon-md" aria-hidden="true"></i><span>${esc(t('subscriptions.settingsTitle'))}</span>
      </button>`}
    </div>`;
}

/** Haken und aria-checked der Sortierung nachziehen, ohne das Menue neu zu bauen. */
function syncToolsMenu() {
  container?.querySelectorAll('#subscriptions-tools-menu [data-sort]').forEach((item) => {
    const on = item.dataset.sort === state.sort;
    item.setAttribute('aria-checked', String(on));
    item.querySelector('.popover-menu__item-check')?.classList.toggle('popover-menu__item-check--hidden', !on);
  });
}

function setSort(sort) {
  if (!SORT_OPTIONS.some(([id]) => id === sort)) return;
  state.sort = sort;
  syncToolsMenu();
  renderContent();
}

function selectHtml(id, label, options, value) {
  return `
    <div class="form-group">
      <label class="form-label" for="${id}">${esc(label)}</label>
      <select class="form-input" id="${id}">
        ${options.map(([optionValue, optionLabel]) => `<option value="${esc(String(optionValue))}"${String(optionValue) === String(value) ? ' selected' : ''}>${esc(optionLabel)}</option>`).join('')}
      </select>
    </div>`;
}

/**
 * Das Filterblatt (Muster: openCalendarFilters). Ein ANSICHTSBLATT, kein
 * Formular: jede Auswahl wirkt sofort, also `dirtyGuard: false` und kein
 * Speichern-Knopf. Die Neutral-Option heisst „Alle" - das Feldlabel steht
 * darueber. Filtern ist Lesen: das Blatt steht auch bei `budget: read`.
 */
function openFilterSheet() {
  const content = `
    <div class="subscriptions-filter-sheet">
      ${selectHtml('subscriptions-category-filter', t('subscriptions.filterLabelCategory'),
        [['', t('common.all')], ...state.meta.categories.map((item) => [item.id, categoryLabel(item)])], state.categoryId)}
      ${selectHtml('subscriptions-method-filter', t('subscriptions.filterLabelMethod'),
        [['', t('common.all')], ...state.meta.payment_methods.map((item) => [item.id, paymentMethodLabel(item)])], state.paymentMethodId)}
      ${selectHtml('subscriptions-status-filter', t('subscriptions.filterLabelStatus'),
        STATUS_OPTIONS.map(([id, key]) => [id, t(key)]), state.status)}
    </div>
    <div class="modal-panel__footer">
      <button type="button" class="btn btn--secondary" id="subscriptions-sheet-reset">${t('subscriptions.resetFilters')}</button>
    </div>
  `;
  openModal({ title: t('subscriptions.filters'), content, size: 'sm', initialFocus: 'first-field', dirtyGuard: false });
  const panel = document.querySelector('#shared-modal-overlay .modal-panel');
  if (!panel) return;
  const FIELDS = {
    'subscriptions-category-filter': 'categoryId',
    'subscriptions-method-filter': 'paymentMethodId',
    'subscriptions-status-filter': 'status',
  };
  panel.addEventListener('change', async (event) => {
    const field = FIELDS[event.target.id];
    if (!field) return;
    state[field] = event.target.value;
    await reload();
  });
  panel.querySelector('#subscriptions-sheet-reset')?.addEventListener('click', resetFilters);
}

/** Ein offenes Filterblatt zeigt den Stand, den Chips oder Zuruecksetzen gerade gesetzt haben. */
function syncFilterSheet() {
  const values = {
    'subscriptions-category-filter': state.categoryId,
    'subscriptions-method-filter': state.paymentMethodId,
    'subscriptions-status-filter': state.status,
  };
  for (const [id, value] of Object.entries(values)) {
    const select = document.querySelector(`#shared-modal-overlay #${id}`);
    if (select) select.value = value;
  }
}

function bindToolbar() {
  // 250ms wie vorher: die Suche ist ein SERVER-Filter (`?q=`), kein Client-Filter.
  searchField = wirePageSearch(container, {
    id: 'subscriptions-search',
    delay: 250,
    onQuery: async (value) => {
      state.query = value.trim();
      await reload();
    },
  });
  container.querySelector('#subscriptions-filters')?.addEventListener('click', openFilterSheet);
  container.querySelector('#subscriptions-active-filters')?.addEventListener('click', (event) => {
    const chip = event.target.closest('[data-remove-filter]');
    if (chip) { removeFilter(chip.dataset.removeFilter); return; }
    if (event.target.closest('#subscriptions-reset-filters')) resetFilters();
  });
  container.querySelector('#subscriptions-tools-menu')?.addEventListener('click', (event) => {
    const item = event.target.closest('.popover-menu__item');
    if (!item) return;
    if (item.dataset.sort) setSort(item.dataset.sort);
    else if (item.id === 'subscriptions-manage') openMetadataModal();
    else if (item.id === 'subscriptions-settings') openSettingsModal();
  });
}

/**
 * Neu laden und zeichnen - nur, solange die Seite noch dieselbe ist.
 *
 * @returns {Promise<boolean>} ob ein frischer Stand gezeichnet wurde (dann darf
 *   der Aufrufer den Fokus zuruecktragen oder einen Dialog neu aufbauen)
 */
async function reload(options, { motion = false, quiet = false, owner = pageOwner() } = {}) {
  // Eine Antwort fuer eine andere Instanz laedt nicht: das Laden schriebe den
  // Stand, den die neue Seite gerade zeigt.
  if (!isCurrentOwner(owner)) return false;
  try {
    const applied = await load(options);
    if (!applied || !isCurrentOwner(owner)) return false;
    renderFilters();
    renderContent({ motion });
    return true;
  } catch (err) {
    if (!isCurrentOwner(owner)) return false;
    if (quiet) console.warn('[Subscriptions] reload failed:', err);
    else window.yuvomi?.showToast(errorSentence(err, 'subscriptions.loadError'), 'danger');
    return false;
  }
}

function sortedSubscriptions() {
  return [...state.subscriptions].sort((a, b) => {
    if (state.sort === 'cost-desc') return (b.monthly_base ?? -1) - (a.monthly_base ?? -1);
    if (state.sort === 'cost-asc') return (a.monthly_base ?? Infinity) - (b.monthly_base ?? Infinity);
    if (state.sort === 'name') return a.name.localeCompare(b.name, getLocale());
    return a.next_payment_date.localeCompare(b.next_payment_date) || a.name.localeCompare(b.name, getLocale());
  });
}

const SUBSCRIPTION_ROW = '.swipe-row[data-swipe-id]';

/* `motion: true` setzt, wer die DATEN geaendert hat (Abo angelegt, gespeichert,
 * verlaengert, geloescht): die neue Zeile zieht auf, und was dadurch die
 * Stelle wechselt, gleitet (utils/list-motion.js). Traeger ist
 * `#subscriptions-content` - `#subscriptions-list` darin baut jedes Zeichnen
 * neu. Filter und Sortierung zeichnen ohne Bewegung neu - dort wechselt die
 * Frage, nicht die Liste. */
function renderContent({ motion = false } = {}) {
  const content = container.querySelector('#subscriptions-content');
  if (motion && content) redrawList(content, drawContent, { selector: SUBSCRIPTION_ROW, keyAttr: 'data-swipe-id' });
  else drawContent();
}

function drawContent() {
  const content = container.querySelector('#subscriptions-content');
  const rows = sortedSubscriptions();
  // Kurs-Status/-Aktion nur, wenn überhaupt ein Abo in Fremdwährung läuft -
  // sonst ist „Wechselkurse nicht verfügbar" eine Dauerwarnung ohne Anlass.
  const baseCurrency = state.summary?.base_currency || state.settings.base_currency;
  const hasForeignCurrency = rows.some((s) => s.currency && s.currency !== baseCurrency);
  // DIE LISTE VOR DER AUSWERTUNG (Critique 2026-09-25): mobil stand die erste
  // Abo-Zeile bei y=1123, hinter Kennzahlen UND drei Diagrammen (592px). Die
  // Liste ist, woran man handelt (verlaengern, bearbeiten); die Diagramme sind
  // die Auswertung dazu und folgen ihr - auf jeder Breite in derselben
  // Reihenfolge, damit Fokus- und Lesereihenfolge dem Bild entsprechen.
  const summary = container.querySelector('#subscriptions-summary');
  if (summary) setHtml(summary, renderSummary());
  const count = container.querySelector('#subscriptions-list-count');
  if (count) count.textContent = String(rows.length);
  const rates = container.querySelector('#subscriptions-rates-slot');
  if (rates) {
    setHtml(rates, !hasForeignCurrency ? ''
      : state.rates?.source === 'unavailable'
        ? `<span class="subscriptions-rate-status subscriptions-rate-status--warning">${t('subscriptions.ratesUnavailable')}</span>`
        : `<button class="btn btn--secondary" id="subscriptions-refresh-rates">
          <i data-lucide="refresh-cw" aria-hidden="true"></i>${t('subscriptions.refreshRates')}
        </button>`);
  }
  setHtml(content, `
      ${renderOverBudgetNote()}
      <div class="subscriptions-list row-carrier" id="subscriptions-list">
        ${rows.length ? rows.map(renderCard).join('') : renderEmpty()}
      </div>
  `);
  const analytics = container.querySelector('#subscriptions-analytics');
  if (analytics) setHtml(analytics, renderAnalytics());
  bindContent();
  if (window.lucide) window.lucide.createIcons({ el: container.querySelector('.subscriptions-page') ?? content });
}

function renderSummary() {
  const summary = state.summary || {
    active_count: 0,
    monthly_total: 0,
    monthly_budget: 0,
    remaining_budget: 0,
    base_currency: state.settings.base_currency,
  };
  const budget = Number(summary.monthly_budget || 0);
  const used = Number(summary.monthly_total || 0);
  const hasBudget = budget > 0;
  // Die echte Auslastung (121 % statt "100 %") nennt die Fussnote vor der
  // Liste (renderOverBudgetNote).
  const isOverBudget = hasBudget && summary.remaining_budget < 0;
  // Geteilte Kennzahl-Zeile und -Karte des Budget-Moduls (budget.css). Die
  // frühere eigene .subscriptions-summary-card war die zweite von fünf
  // Bauarten im selben Modul (Critique 2026-07-30, P0).
  // Rolle `plain`: Abo-Kosten sind Rechnungsbeträge ohne Kontorichtung.
  //
  // UEBER BUDGET SAGT DASSELBE WIE IM PLAN (Critique 2026-09-25). Eine
  // tatsaechliche Ueberschreitung ist eine Tatsache und traegt den Danger-Ton
  // wie die ueberzogene Plan-Kategorie (seit R21 S7 am Balken, Symbol und
  // Label als Text); die Annaeherung ab 85 % traegt den Warnton am Balken -
  // wie im Plan. Neu ist der Weg zur Handlung: zur Liste, teuerste zuerst.
  // Das ist Lesen, kein Schreiben - der Weg steht bei jedem Recht.
  //
  // DIE WAEHRUNG STEHT EINMAL: die Jahresprognose trug unter „1.363,20 €"
  // noch „EUR". Die Fussnote sagt jetzt, woraus die Zahl entsteht.
  // MOBIL EINE ZEILE (R14 P1, A5 P1-3): vier Karten (2x2, 200px) standen vor
  // der ersten Abo-Zeile (y=478 bei 390x844). Unter 640px nennt eine Zeile die
  // Monatskosten und daneben Zahl und Budgetstand; ein Tipp klappt die Karten
  // auf (metric-glance.js, dieselbe Form wie die Budget-Uebersicht).
  //
  // OHNE MONATSBUDGET DREI KARTEN (#1607). Die Karte „Monatsbudget" zeigte
  // dann „0,00 €" mit leerem Balken, direkt neben „Kein Budgetlimit -
  // Unbegrenzt". Wo kein Budget gesetzt ist, gibt es keine Zahl dafuer; den
  // Zustand nennt die Karte daneben. Drei Karten sind die Grundform der Reihe
  // (panel.css) - seit R19 auch MIT Budget: es steht in der Kostenkarte.
  /* EINE KENNZAHL, EINE ZEILE, IN JEDER BREITE (R24, E2; Critique
   * G4-Budget-P2-3). Bis R24 standen rechts drei Karten - Monatskosten mit
   * Balken, "Ueber Budget 23,60 €" (die zweite Fassung des roten Balkens) und
   * die Jahresprognose -, mobil dieselben hinter einem Aufklapper. Jetzt die
   * Kurzzeile oben in der Bahn: die Monatskosten fuehren, daneben der
   * Budgetstand (ueber dem Budget im Danger-Ton) und das Jahr. Die Zahl der
   * Abos steht am Kopf der Liste, die sie zaehlt. Der Weg zur Handlung bei
   * einer Ueberschreitung ("Teuerste zuerst") steht seit S13 vor der Liste. */
  const budgetFlow = hasBudget
    ? { label: t(isOverBudget ? 'subscriptions.overBudget' : 'subscriptions.remainingBudget'),
      amount: money(Math.abs(summary.remaining_budget)), tone: isOverBudget ? 'negative' : '' }
    : null;
  return `
    ${metricGlanceHtml({
    label: t('subscriptions.monthlyCost'),
    value: money(used),
    lead: true,
    everywhere: true,
    flows: [budgetFlow, { label: t('subscriptions.yearlyProjection'), amount: money(used * 12) }],
  })}
  `;
}

/* DIE FUSSNOTE STEHT VOR DER LISTE, DIE SIE SORTIERT (R24 S13, S12-F3).
 * "126 % des Budgets genutzt - Teuerste zuerst" stand unter der Kurzzeile.
 * Deren Skelett (82px) kannte sie nicht, die echte Zeile wuchs auf 111px und
 * schob beim Reiterwechsel den Listenkopf (Shift 0,0233 mobil, 0,0068
 * Desktop). Jetzt ist der Kennzahl-Slot so hoch wie sein Skelett, und die
 * Fussnote kommt im selben Bild wie die Zeilen, die das Listen-Skelett
 * ersetzen - neue Knoten verschieben nichts. Der Weg steht so auch dort, wo
 * er wirkt: direkt ueber den Zeilen, die er umsortiert. */
function renderOverBudgetNote() {
  const summary = state.summary;
  const budget = Number(summary?.monthly_budget || 0);
  if (!(budget > 0) || !(summary.remaining_budget < 0)) return '';
  const realPercentage = Math.round((Number(summary.monthly_total || 0) / budget) * 100);
  return `<p class="subscriptions-over-budget">${esc(percentText(realPercentage))} ${t('subscriptions.budgetUsed')} <button type="button" class="subscriptions-over-budget-action" id="subscriptions-over-budget-action">${t('subscriptions.overBudgetAction')}</button></p>`;
}

/** „Teuerste zuerst": sortiert die Liste und bringt ihren Kopf in den Blick. */
function showMostExpensive() {
  setSort('cost-desc');
  const heading = container.querySelector('#subscriptions-list-title');
  if (!heading) return;
  // NUR der eigene Scrollport bewegt sich. `scrollIntoView` scrollte auch die
  // Vorfahren mit und schob den Budget-Kopf samt Tabs aus dem Bild.
  const port = heading.closest('.page-scrollport');
  if (port) {
    const section = heading.closest('.subscriptions-list-section') ?? heading;
    const top = section.getBoundingClientRect().top - port.getBoundingClientRect().top + port.scrollTop;
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    port.scrollTo({ top: Math.max(0, top), behavior: reduce ? 'auto' : 'smooth' });
  }
  heading.focus({ preventScroll: true });
}

function renderAnalytics() {
  const categories = amountRows(state.summary?.by_category || [], categoryLabel);
  const methods = amountRows(state.summary?.by_payment_method || [], paymentMethodLabel);
  const forecast = renewalForecast();
  return `
    <section class="subscriptions-analytics">
      ${renderAreaChart(t('subscriptions.renewalForecast'), forecast)}
      ${renderBreakdown(t('subscriptions.byCategory'), categories)}
      ${renderBreakdown(t('subscriptions.byPaymentMethod'), methods)}
    </section>
  `;
}

function amountRows(rows, labelFor) {
  return rows
    .map((row) => ({ ...row, label: labelFor(row), amount: Number(row.amount || 0) }))
    .filter((row) => row.amount > 0)
    .sort((a, b) => b.amount - a.amount);
}

function dueAmount(subscription) {
  if (subscription.monthly_base === null) return 0;
  if (subscription.currency === (state.summary?.base_currency || state.settings.base_currency)) return Number(subscription.amount || 0);
  const nativeMonthly = Number(subscription.monthly_native || 0);
  if (!nativeMonthly) return Number(subscription.monthly_base || 0);
  return Number(subscription.amount || 0) * (Number(subscription.monthly_base || 0) / nativeMonthly);
}

function renewalForecast() {
  const today = new Date(`${todayKey()}T00:00:00`);
  const start = new Date(today.getFullYear(), today.getMonth(), 1);
  const months = Array.from({ length: 6 }, (_, index) => {
    const date = addMonths(start, index);
    return { key: monthKey(date), label: monthLabel(monthKey(date)), amount: 0 };
  });
  const monthMap = new Map(months.map((row) => [row.key, row]));
  const end = addMonths(start, months.length);
  for (const subscription of state.subscriptions.filter((row) => row.enabled)) {
    const boundary = subscriptionEndBoundary(subscription);
    let due = new Date(`${subscription.next_payment_date}T00:00:00`);
    while (due < start) due = addCycleDate(due, subscription.billing_cycle, subscription.cycle_interval || 1);
    while (due < end && (!boundary || due <= boundary)) {
      const row = monthMap.get(monthKey(due));
      if (row) row.amount += dueAmount(subscription);
      due = addCycleDate(due, subscription.billing_cycle, subscription.cycle_interval || 1);
    }
  }
  return months.map((row) => ({ ...row, amount: Number(row.amount.toFixed(2)) }));
}

// KEINE geteilte Chart-Geometrie (utils/chart.js), und das ist Absicht: die
// traegt einen 40px-Gutter fuer eine Werteachse, und diese Flaeche hat keine.
// Sie ist 72px flach, beschriftet alle sechs Monate statt drei Marken und liegt
// damit naeher an der Sparkline der Kennzahlkarte als am Trend-Chart. Eine
// andere FORM, keine andere Fassung derselben.
//
// `vector-effect` ist dagegen faellig: `preserveAspectRatio="none"` streckt
// einen 100x52-viewBox auf rund 300x72, also X um Faktor 3 und Y um 1,4 - ohne
// den Ausschalter wird die 2,5px-Linie in einer Achse dicker als in der
// anderen. Dieselbe Zeile steht an jeder anderen gestreckten Kurve der App.
//
// DIE ZAHL IM KOPF SAGT, WAS SIE IST (Critique 2026-09-25): dort stand nackt
// „196,86 €" - der hoechste Monat, aber weder sichtbar noch vorlesbar als
// solcher benannt, und die Kurve selbst ist aria-hidden. Jetzt traegt die Zahl
// ihr Label, und die sechs Monatswerte stehen als Liste fuer Screenreader.
function renderAreaChart(title, rows) {
  const max = Math.max(...rows.map((row) => row.amount), 1);
  const points = rows.map((row, index) => {
    const x = rows.length === 1 ? 50 : Math.round((index / (rows.length - 1)) * 100);
    const y = Math.round(46 - ((row.amount / max) * 34));
    return `${x},${y}`;
  }).join(' ');
  const areaPoints = `0,52 ${points} 100,52`;
  const peak = rows.reduce((best, row) => (row.amount > (best?.amount ?? 0) ? row : best), null);
  return `
    <article class="subscriptions-chart subscriptions-chart--area">
      <h2 class="u-section-title subscriptions-chart__title">${title}</h2>
      <div class="subscriptions-chart__card">
      ${peak ? `<p class="subscriptions-chart__figure">
          <span>${esc(t('subscriptions.forecastPeak', { month: peak.label }))}</span>
          <strong>${money(peak.amount)}</strong>
        </p>` : ''}
      <svg class="subscriptions-area-chart" viewBox="0 0 100 52" preserveAspectRatio="none" aria-hidden="true">
        <polygon points="${areaPoints}"></polygon>
        <polyline points="${points}" vector-effect="non-scaling-stroke"></polyline>
      </svg>
      <div class="subscriptions-chart-axis" aria-hidden="true">
        ${rows.map((row) => `<span>${esc(row.label)}</span>`).join('')}
      </div>
      <ul class="sr-only">
        ${rows.map((row) => `<li>${esc(row.label)}: ${money(row.amount)}</li>`).join('')}
      </ul>
      </div>
    </article>
  `;
}

// EIN BALKEN-BAUSTEIN FUER BEIDE AUFTEILUNGEN. „Nach Kategorie" war eine Torte
// (conic-gradient auf einem div): ohne Textalternative, die Legende ohne Werte,
// und sie zeigte nur vier von sechs Segmenten (Critique 2026-09-25). Jetzt
// dieselbe Zeile wie „Nach Zahlungsart": Name, Balken, Betrag und Anteil. Die
// Zeile IST ihr Textaequivalent - eine Liste mit Name, Betrag und Anteil in
// Klartext; nur der Balken ist Dekor. Die Balkenlaenge misst am groessten
// Posten, der Anteil am Ganzen - beides ehrlich, kein Mindestbreiten-Trick.
function renderBreakdown(title, rows) {
  const max = Math.max(...rows.map((row) => row.amount), 1);
  const total = rows.reduce((sum, row) => sum + row.amount, 0) || 1;
  const percent = getNumberFormat({ style: 'percent', maximumFractionDigits: 0 });
  return `
    <article class="subscriptions-chart">
      <h2 class="u-section-title subscriptions-chart__title">${title}</h2>
      <div class="subscriptions-chart__card">
      ${rows.length ? `<ul class="subscriptions-chart-rows">${rows.map((row) => `
        <li class="subscriptions-chart-row">
          <span class="subscriptions-chart-row__label">${esc(row.label)}</span>
          <span class="subscriptions-chart-row__track" aria-hidden="true"><span class="budget-bar-row__fill budget-bar-row__fill--expenses" style="--bar-scale:${(row.amount / max).toFixed(4)}"></span></span>
          <strong>${money(row.amount)}</strong>
          <span class="subscriptions-chart-row__share">${percent.format(row.amount / total)}</span>
        </li>
      `).join('')}</ul>` : `<p>${t('subscriptions.noAnalytics')}</p>`}
      </div>
    </article>
  `;
}

/** Abgeschlossen (#594)? Karte, Leseansicht und Dialog fragen dasselbe (#2009). */
function isCompleted(subscription) {
  return subscription?.status === 'completed';
}

function statusMeta(subscription) {
  const status = subscription.status || (subscription.enabled ? 'active' : 'paused');
  if (status === 'completed') return { cardClass: 'subscription-card--completed', badgeClass: 'subscription-status--completed', label: t('subscriptions.completed') };
  if (status === 'active') return { cardClass: '', badgeClass: 'subscription-status--active', label: t('subscriptions.active') };
  return { cardClass: 'subscription-card--disabled', badgeClass: '', label: t('subscriptions.disabled') };
}

// Ende-Zeile in der Card (#594): abgeschlossen, Enddatum oder Restzahlungen.
function endInfoLabel(subscription) {
  if (subscription.status === 'completed') {
    // completed_at ist ein ZEITPUNKT: dateText rechnet ihn in die Haushaltszone
    // (R23) - der abgeschnittene UTC-String nannte abends den Folgetag.
    return { icon: 'circle-check', text: subscription.completed_at ? t('subscriptions.completedOn', { date: dateText(subscription.completed_at) }) : t('subscriptions.completed') };
  }
  if (subscription.end_type === 'on_date' && subscription.end_date) {
    return { icon: 'calendar-x', text: t('subscriptions.endsOn', { date: dateText(subscription.end_date) }) };
  }
  if (subscription.end_type === 'after_count') {
    return { icon: 'list-ordered', text: t('subscriptions.endsAfter', { count: Number(subscription.occurrences_remaining ?? 0) }) };
  }
  return null;
}

// Die Zeile fuehrt ZWEI Aktionen, und welche, sagt der Rang (§2, Session 16):
// der Zeilenanfang die primaere positive - eine Zahlung buchen -, das Zeilenende
// das Destruktive. Bearbeiten liegt auf dem TAP, nicht auf einer Wischrichtung
// und nicht mehr auf einem eigenen Knopf; der Zustandsschalter ist ganz
// entfallen, weil dasselbe Feld im Bearbeiten-Formular steht. Vier Icon-Knoepfe
// je Zeile waren die lauteste Stelle des Bildschirms, uebrig sind zwei.
//
// BEWUSST kein aria-label am Zeilenkoerper: `role=button` ist per ARIA "children
// presentational", das Label haette also den ganzen Inhalt ersetzt - Name,
// Status, Faelligkeit, Zyklus, Zahlungsart und Betrag zusammen zu "Bearbeiten,
// Schaltfläche". Genau derselbe Beschluss steht in `pantry.js` (Critique P1,
// WCAG 1.3.1/4.1.2) und `contacts.js`. Aus demselben Grund tragen Name und
// Beschreibung `<span>` statt `<h3>`/`<p>`: Content-Model eines `<button>` ist
// Phrasing Content. Was der Knopf TUT, kommt als sr-only Zusatz ans Ende.
/** Der Standard der Erinnerung (Dialog und Route: 3 Tage vorher). */
const DEFAULT_REMINDER_DAYS = 3;

/** Weicht die Erinnerung dieses Abos vom Standard ab (aus oder andere Frist)? */
function reminderDiffers(subscription) {
  return subscription.reminder_enabled === false || Number(subscription.reminder_days ?? DEFAULT_REMINDER_DAYS) !== DEFAULT_REMINDER_DAYS;
}

function renderCard(subscription) {
  const brandColor = subscription.brand_color || subscription.category_color || SUBSCRIPTION_COLOR_DEFAULT;
  const status = statusMeta(subscription);
  const endInfo = endInfoLabel(subscription);
  // BEI `budget: read` OEFFNET DER ZEILENKOERPER DIE LESEANSICHT statt des
  // Bearbeitens (`view` statt `edit`, P1-Muster) und sagt kein „Bearbeiten"
  // mehr an. Verlaengern und Loeschen daneben schreiben und fallen weg, die
  // Wischflaechen mit ihnen, weil die Geste nicht verdrahtet wird.
  const ro = readOnly();
  // KOMPAKT IN DER GRAMMATIK DER BUCHUNGSZEILE (Critique 2026-09-25): mobil war
  // eine Abo-Zeile 173px hoch - Name, Beschreibung, Status-Pille, fuenf
  // Metaangaben mit je einem Symbol, darunter Betrag UND „39,00 € pro Monat".
  // Jetzt: eine Titelzeile (Name, dahinter leise die Beschreibung), eine
  // Metazeile, rechts der Betrag. Was sich wiederholte, faellt:
  // - „Aktiv" ist der Normalfall der Liste und stand an jeder Zeile; die Pille
  //   bleibt dort, wo sie etwas unterscheidet (pausiert, abgeschlossen).
  // - Der Monatswert steht nur, wenn er vom Betrag abweicht (anderer Zyklus,
  //   Fremdwaehrung) oder nicht umgerechnet werden konnte.
  // - Nur Faelligkeit und Erinnerung tragen ein Symbol; Zyklus und Zahlungsart
  //   sind Woerter, die sich selbst erklaeren.
  // - In einer schmalen Liste (Telefon) bleiben Faelligkeit, Zyklus und Ende;
  //   Zahlungsart und Erinnerung (`__meta-extra`) stehen in der Detailansicht,
  //   die der Tap auf die Zeile oeffnet. Ziel war <=100px je Zeile.
  const baseCurrency = state.summary?.base_currency || state.settings.base_currency;
  const sameAsMonthly = subscription.billing_cycle === 'monthly'
    && Number(subscription.cycle_interval || 1) === 1
    && subscription.currency === baseCurrency;
  const converted = subscription.monthly_base === null
    ? t('subscriptions.conversionUnavailable')
    : (sameAsMonthly ? '' : t('subscriptions.monthlyEquivalent', { amount: money(subscription.monthly_base) }));
  // EIN ABGESCHLOSSENES ABO HAT KEINE FAELLIGKEIT (#2009). Sein Datum ist das
  // der Zahlung, die nach dem Abschluss kaeme - es zaehlt erst wieder, wenn das
  // Abo reaktiviert wird, und der Dialog bietet es dann an. Auf der Karte stand
  // es als „in 30 Tagen"; die Ende-Zeile sagt stattdessen „Abgeschlossen am".
  //
  // Es hat auch keine naechste ZAHLUNG und keine Erinnerung (#2011): der Server
  // lehnt "Bezahlt" ab, syncReminder hat die Erinnerung entfernt. Knopf,
  // Wischgeste und Erinnerungs-Chip fallen deshalb weg, statt eine Handlung
  // und einen Termin anzubieten, die es nicht gibt.
  const completed = isCompleted(subscription);
  const overdue = !completed && daysUntil(subscription.next_payment_date) < 0;
  const canRenew = !ro && !completed;
  return `
    <div class="swipe-row${ro ? ' swipe-row--static' : ''}" data-swipe-id="${subscription.id}">
      ${canRenew ? `<div class="swipe-reveal swipe-reveal--done swipe-reveal--leading" aria-hidden="true">
        <i data-lucide="calendar-check" class="icon-md"></i>
        <span>${t('subscriptions.markRenewed')}</span>
      </div>` : ''}
      ${ro ? '' : `<div class="swipe-reveal swipe-reveal--delete swipe-reveal--trailing" aria-hidden="true">
        <i data-lucide="trash-2" class="icon-md"></i>
        <span>${t('common.delete')}</span>
      </div>`}
    <article class="subscription-card ${status.cardClass}"
             data-id="${subscription.id}" style="--subscription-color:${esc(brandColor)}">
      <button type="button" class="subscription-card__main list-row__main--interactive"
              data-action="view">
        <span class="subscription-card__brand budget-tile">
          ${subscription.logo_data
            ? `<img src="${esc(subscription.logo_data)}" alt="">`
            : `<span>${esc(subscription.name.slice(0, 2).toUpperCase())}</span>`}
        </span>
        <span class="subscription-card__body">
          <span class="subscription-card__title-row">
            <span class="subscription-card__name">${esc(subscription.name)}</span>
            <span class="subscription-card__desc">${esc(subscription.description || rowCategoryLabel(subscription))}</span>
            ${status.badgeClass === 'subscription-status--active' ? '' : `<span class="subscription-status ${status.badgeClass}">${status.label}</span>`}
          </span>
          <span class="subscription-card__meta">
            ${/* SCHMAL STEHT DIE BESCHREIBUNG IN DER META-ZEILE (R19, Critique
                 2026-10-16): hinter dem Namen blieben ihr bei 390px 40-60px
                 ("Lind...", "Bis zu 6 Ko..."), der Name selbst kuerzte mit
                 ("Microsoft 365 Fa..."). Immer genau eine der beiden Fassungen
                 (subscriptions.css), wie beim Turnus. */ ''}
            <span class="subscription-card__meta-desc">${esc(subscription.description || rowCategoryLabel(subscription))}</span>
            ${completed ? '' : `<span class="subscription-card__due${overdue ? ' subscription-card__due--overdue' : ''}"><i data-lucide="${overdue ? 'triangle-alert' : 'calendar-clock'}" aria-hidden="true"></i><span>${esc(dateText(subscription.next_payment_date))} ·</span> <span>${dueLabel(subscription)}</span></span>`}
            <span class="subscription-card__meta-cycle">${cycleLabel(subscription)}</span>
            ${/* DIE METAZEILE SAGT, WAS DIESES ABO UNTERSCHEIDET (Critique R24
                 G4-Budget-P3-2): Zahlart und "3 Tage vorher" standen in JEDER
                 Zeile - fuenf Angaben, zwei davon ueberall gleich. Die Zahlart
                 steht im Leseblatt; die Erinnerung nur, wo sie vom Standard
                 (3 Tage) abweicht oder aus ist. */ ''}
            ${completed || !reminderDiffers(subscription) ? '' : `<span class="subscription-card__meta-extra"><i data-lucide="${subscription.reminder_enabled === false ? 'bell-off' : 'bell'}" aria-hidden="true"></i>${subscription.reminder_enabled === false ? t('subscriptions.noReminder') : t('subscriptions.reminderMeta', { count: subscription.reminder_days })}</span>`}
            ${endInfo ? `<span><i data-lucide="${endInfo.icon}" aria-hidden="true"></i>${esc(endInfo.text)}</span>` : ''}
            ${/* RUHIG, ABER AUCH AM TELEFON (Entscheidung zu #1277): das Konto
                 ist archiviert, das Abo bucht ohne Konto. Eine Metaangabe wie
                 die anderen, kein Warnton - nichts ist kaputt, es fehlt nur
                 die Zuordnung, bis jemand ein anderes Konto waehlt. */ ''}
            ${subscription.account_archived && !completed ? `<span class="subscription-card__meta-account"><i data-lucide="archive" aria-hidden="true"></i>${esc(t('subscriptions.accountArchivedMeta', { name: subscription.account_name || '' }))}</span>` : ''}
          </span>
        </span>
        <span class="subscription-card__cost">
          <strong>${money(subscription.amount, subscription.currency)}</strong>
          ${converted ? `<span>${converted}</span>` : ''}
          <span class="subscription-card__cost-cycle">${cycleLabel(subscription)}</span>
        </span>
      </button>
      ${/* DIE ENDZONE WIE IN JEDEM BUDGET-REITER (R22, D9 nach R21-D10):
           [eine Handlung][Mehr-Knopf]. Bis dahin stand am Zeiger nur der
           Kalenderhaken und am Finger ein Wisch-Chevron - Loeschen gab es nur
           per Geste und im Dialog. Der Mehr-Knopf traegt Verlaengern und
           Loeschen sichtbar auf jedem Geraet; der Haken bleibt am Zeiger die
           EINE Handlung davor, am Finger ist er das Wischen zum Zeilenanfang. */ ''}
      ${ro ? '' : `<div class="row-actions subscription-card__actions">
        ${canRenew ? rowActionHtml({ icon: 'calendar-check', action: 'renew', label: t('subscriptions.markRenewedNamed', { name: subscription.name }) }) : ''}
        ${rowMenuHtml({
          id: `subscription-menu-${subscription.id}`,
          label: t('common.moreActionsNamed', { name: subscription.name }),
          className: 'row-action--slim',
          defer: true,
          items: [
            canRenew ? { action: 'renew', icon: 'calendar-check', label: t('subscriptions.markRenewed') } : null,
            { action: 'delete', icon: 'trash-2', label: t('common.delete'), danger: true },
          ],
        })}
      </div>`}
    </article>
    </div>
  `;
}

/**
 * Die Wischgesten der Abo-Liste. Zuordnung nach dem app-weiten Rang: der
 * Zeilenanfang traegt die primaere positive Aktion (eine Zahlung buchen), das
 * Zeilenende das Destruktive.
 *
 * KEINE der beiden Richtungen laesst die Zeile hinausfliegen. Beide fuehren
 * ueber eine Bestaetigung, und was danach kommt, entscheidet der Nutzer - eine
 * Zeile, die schon weg ist, waehrend der Dialog noch fragt, hat die Antwort
 * vorweggenommen. Der Knopf daneben ruft dieselbe Funktion, damit die Geste
 * keine zweite Schreibweise derselben Arbeit wird.
 */
function wireSubscriptionSwipe(host) {
  wireSwipeRows(host, {
    card: '.subscription-card',
    leading: {
      reveal: '.swipe-reveal--done',
      run: (row) => {
        const subscription = subscriptionFor(row);
        // Eine abgeschlossene Zeile hat kein Panel am Anfang (#2011); der Wisch
        // dorthin federt zurueck, renewSubscription fragt gar nicht erst.
        if (subscription) renewSubscription(subscription);
      },
    },
    trailing: {
      reveal: '.swipe-reveal--delete',
      run: (row) => {
        const subscription = subscriptionFor(row);
        if (subscription) deleteSubscription(subscription);
      },
    },
  });
}

// Beide Richtungen RUFEN ihre Funktion, statt sie einem Helfer zu uebergeben.
// Der Guard auf Ebene 3 folgt von der Wischrichtung der Aufrufkante zu der
// Funktion, in der der Rueckweg steht - eine als Argument durchgereichte
// Referenz waere fuer ihn keine Kante, und er haette den Rueckweg nicht
// gefunden, obwohl er da ist. Eine Verdrahtung, die ein Guard nicht lesen kann,
// ist eine, die beim naechsten Mal niemand prueft.
function subscriptionFor(row) {
  return state.subscriptions.find((item) => item.id === Number(row.dataset.swipeId));
}

function renderEmpty() {
  // „Keine Abos" und „nichts passt zum Filter" sind verschiedene Zustände: der
  // erste braucht eine Anlegen-Aktion, der zweite einen Weg zurück. Die
  // Variante traegt den Unterschied jetzt mit: `no-results` wird als
  // `role="status"` angesagt und fuehrt einen sekundaeren CTA.
  //
  // Seit Critique R23 (Q4) der geteilte Leerzustand der Suche: Suchbegriff und
  // Filter als Chips, "Suche zuruecksetzen" nimmt beides zurueck - dieselbe
  // Form wie in Budget, Kontakten und Notizen statt eines eigenen "Filter"-Satzes.
  if (hasActiveFilters()) {
    return searchEmptyHTML({
      query: state.query,
      filters: activeFilters().map((filter) => filter.value),
      resetAttrs: { id: 'subscriptions-empty-reset' },
    });
  }
  // Bei `budget: read` bleibt nur der Titel: Beschreibung und CTA sind die
  // Aufforderung zum Anlegen. Der Filter-Leerzustand oben bleibt ganz - sein
  // Weg zurueck ist ein Filter, kein Schreibweg.
  const ro = readOnly();
  return emptyStateHTML({
    icon: 'repeat-2',
    title: t('subscriptions.emptyTitle'),
    description: ro ? '' : t('subscriptions.emptyDescription'),
    action: ro ? null : { label: t('subscriptions.add'), attrs: { id: 'subscriptions-empty-add' } },
  });
}

function bindContent() {
  container.querySelector('#subscriptions-refresh-rates')?.addEventListener('click', () => reload({ refreshRates: true }));
  container.querySelector('#subscriptions-empty-add')?.addEventListener('click', () => openSubscriptionModal());
  container.querySelector('#subscriptions-empty-reset')?.addEventListener('click', resetFilters);
  container.querySelector('#subscriptions-over-budget-action')?.addEventListener('click', showMostExpensive);
  const list = container.querySelector('#subscriptions-list');
  list?.addEventListener('click', async (event) => {
    const action = event.target.closest('[data-action]');
    const card = event.target.closest('.subscription-card');
    const subscription = state.subscriptions.find((row) => row.id === Number(card?.dataset.id));
    if (!subscription) return;

    if (!action) return;
    // Der Riegel vor der ersten Aktion: das Markup nimmt die Affordanz, das hier
    // auch einem Knoten aus einem aelteren Render die Wirkung.
    if (readOnly() && !READ_SAFE_ACTIONS.has(action.dataset.action)) return;
    // Der Zeilenkoerper OEFFNET das Bearbeiten und ist dafuer ein echter
    // `<button>` (`.list-row__main--interactive`, das app-weite Vokabular fuer
    // eine klickbare Zeile). Ein blosser Tap-Handler auf dem `<article>` haette
    // den Bearbeiten-Knopf entfernt, ohne einen Tastaturweg an seine Stelle zu
    // setzen - das waere kein Aufraeumen, sondern ein Regress.
    if (action.dataset.action === 'view') openSubscriptionReadView(subscription, { editable: !readOnly() });
    if (action.dataset.action === 'edit') openSubscriptionModal(subscription);
    if (action.dataset.action === 'renew') await renewSubscription(subscription);
    if (action.dataset.action === 'delete') await deleteSubscription(subscription);
  });
  // Wischen hat kein Markup, das man wegnehmen koennte (Regel 3 in
  // utils/module-access.js): bei `read` bleibt die VERDRAHTUNG aus - ein Riegel
  // im Ende-Handler kaeme erst, wenn die Zeile schon verschoben ist. Und ohne
  // Geste auch kein Hinweis auf eine.
  if (list && !readOnly()) {
    wireSubscriptionSwipe(list);
    maybeShowSwipeHint(list);
  }
}

function currencyItems() {
  let names;
  try {
    names = new Intl.DisplayNames([getLocale()], { type: 'currency' });
  } catch {
    names = null;
  }
  return CURRENCY_CODES.map((code) => ({
    value: code,
    label: `${code} · ${names?.of(code) || code}`,
  }));
}

// Ein Auswahlfeld mit Tippfilter, kein Suchfeld: es steht im Formular neben
// anderen Feldern, traegt ein sichtbares Label und zeigt den GEWAEHLTEN Wert
// („EUR · Euro"). Deshalb `type="text"` (die Rolle kommt aus role="combobox")
// und die Feldform des Formulars, nicht die Suchkapsel (Komponenten-Kanon).
function comboboxMarkup({ id, label, items, value = '', placeholder, required = false }) {
  const selected = items.find((item) => String(item.value) === String(value));
  return `
    <div class="form-group subscriptions-combobox" data-combobox="${id}">
      <label class="form-label" for="${id}-search">${label}${required ? REQUIRED_MARK : ''}</label>
      <div class="subscriptions-combobox__control">
        <i data-lucide="search" aria-hidden="true"></i>
        <input class="form-input" id="${id}-search" type="text" role="combobox"
               aria-autocomplete="list" aria-expanded="false" aria-controls="${id}-options"
               autocomplete="off" placeholder="${esc(placeholder)}" value="${esc(selected?.label || '')}">
        <input id="${id}" type="hidden" value="${esc(selected?.value ?? '')}">
      </div>
      <div class="subscriptions-combobox__options" id="${id}-options" role="listbox" hidden>
        ${items.map((item) => `
          <button type="button" role="option" data-value="${esc(item.value)}"
                  aria-selected="${String(item.value) === String(value)}">${esc(item.label)}</button>
        `).join('')}
      </div>
    </div>
  `;
}

function wireCombobox(panel, id) {
  const root = panel.querySelector(`[data-combobox="${id}"]`);
  const search = root.querySelector(`#${id}-search`);
  const value = root.querySelector(`#${id}`);
  const options = [...root.querySelectorAll('[role="option"]')];
  let suppressFocusOpen = false;
  const open = () => {
    root.querySelector('.subscriptions-combobox__options').hidden = false;
    search.setAttribute('aria-expanded', 'true');
  };
  const close = () => {
    root.querySelector('.subscriptions-combobox__options').hidden = true;
    search.setAttribute('aria-expanded', 'false');
  };
  const select = (option) => {
    value.value = option.dataset.value;
    search.value = option.textContent.trim();
    options.forEach((item) => item.setAttribute('aria-selected', String(item === option)));
    close();
    // Das Wertfeld ist ein verstecktes Input, das nur programmatisch gesetzt
    // wird - ohne dieses Event erfährt niemand von der Auswahl. Die Betragsfelder
    // hängen an der Währungs-Combobox und müssen dabei nachziehen.
    value.dispatchEvent(new Event('change', { bubbles: true }));
  };
  const selectFromKeyboard = (option) => {
    select(option);
    suppressFocusOpen = true;
    search.focus({ preventScroll: true });
    setTimeout(() => { suppressFocusOpen = false; }, 120);
  };
  const filter = () => {
    const query = search.value.trim().toLocaleLowerCase(getLocale());
    options.forEach((option) => {
      option.hidden = Boolean(query) && !option.textContent.toLocaleLowerCase(getLocale()).includes(query);
    });
    open();
  };
  search.addEventListener('focus', () => {
    if (suppressFocusOpen) return;
    search.select();
    filter();
  });
  search.addEventListener('input', () => {
    value.value = '';
    filter();
  });
  search.addEventListener('keydown', (event) => {
    const visible = options.filter((option) => !option.hidden);
    const active = visible.indexOf(document.activeElement);
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      open();
      (visible[Math.min(active + 1, visible.length - 1)] || visible[0])?.focus();
    }
    if (event.key === 'Enter' && visible.length && !isImeComposing(event)) {
      event.preventDefault();
      event.stopPropagation();
      selectFromKeyboard(visible[0]);
    }
    if (event.key === 'Escape' && !root.querySelector('.subscriptions-combobox__options').hidden) {
      // Offene Liste: Esc schliesst nur sie. preventDefault sagt dem Modal
      // (onEscape), dass das Esc verbraucht ist - sonst ginge das Formular mit.
      event.preventDefault();
      close();
    }
  });
  options.forEach((option) => {
    option.addEventListener('pointerdown', (event) => {
      event.preventDefault();
    });
    option.addEventListener('click', (event) => {
      event.preventDefault();
      select(option);
    });
    option.addEventListener('keydown', (event) => {
      const visible = options.filter((item) => !item.hidden);
      const index = visible.indexOf(option);
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        visible[Math.max(0, Math.min(visible.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1)))]?.focus();
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        close();
        search.focus();
      }
    });
  });
  root.addEventListener('focusout', () => setTimeout(() => {
    if (!root.contains(document.activeElement)) close();
  }, 0));
}

/**
 * Die Zeilen der Leseansicht eines Abos (#1265 P7): was der Bearbeiten-Dialog
 * zeigt, als Text. Die Karte traegt schon Name, Status, Faelligkeit, Zyklus,
 * Zahlungsart, Erinnerung und Betrag; nur der Dialog kannte bisher Kategorie
 * (wo eine Beschreibung sie auf der Karte verdraengt), das Konto, unter dem
 * das Abo laeuft, und die Notizen. Die Markenfarbe traegt der Farbstreifen.
 * Leere Zeilen faellt `detailRowEl` selbst weg - die Antwort folgt dem Datensatz.
 */
function subscriptionReadSections(subscription) {
  const converted = subscription.monthly_base === null
    ? t('subscriptions.conversionUnavailable')
    : t('subscriptions.monthlyEquivalent', { amount: money(subscription.monthly_base) });
  const endInfo = endInfoLabel(subscription);
  return [
    { icon: 'banknote', label: t('subscriptions.detailAmountLabel'),
      value: `${money(subscription.amount, subscription.currency)} · ${converted}` },
    { icon: 'info', label: t('subscriptions.filterLabelStatus'), value: statusMeta(subscription).label },
    { icon: 'align-left', label: t('subscriptions.descriptionLabel'), value: subscription.description || '', multiline: true },
    { icon: 'repeat-2', label: t('subscriptions.billingCycleLabel'), value: cycleLabel(subscription) },
    { icon: 'calendar-clock', label: t('subscriptions.detailNextPaymentLabel'),
      // Abgeschlossen: keine naechste Zahlung (#2009, wie die Karte).
      value: subscription.next_payment_date && !isCompleted(subscription)
        ? `${dateText(subscription.next_payment_date, { weekday: true })} · ${dueLabel(subscription)}` : '' },
    // Abgeschlossen: keine Erinnerung (#2011) - syncReminder hat sie entfernt.
    { icon: subscription.reminder_enabled === false ? 'bell-off' : 'bell', label: t('subscriptions.reminderDaysLabel'),
      value: isCompleted(subscription) ? '' : subscription.reminder_enabled === false ? t('subscriptions.noReminder') : t('subscriptions.reminderMeta', { count: subscription.reminder_days }) },
    { icon: endInfo?.icon || 'calendar-x', label: t('subscriptions.endLabel'), value: endInfo?.text || '' },
    { icon: 'tags', label: t('subscriptions.categoryLabel'), value: subscription.category_id ? rowCategoryLabel(subscription) : '' },
    { icon: 'wallet-cards', label: t('subscriptions.paymentMethodLabel'),
      value: subscription.payment_method_id ? rowPaymentMethodLabel(subscription) : '' },
    { icon: 'wallet', label: t('budget.accountLabel'),
      value: subscription.account_id == null ? ''
        : (subscription.account_archived
          ? t('subscriptions.accountArchivedMeta', { name: subscription.account_name || '' })
          : subscription.account_name || '') },
    { icon: 'at-sign', label: t('subscriptions.accountUsernameLabel'), value: subscription.account_username || '' },
    { icon: 'sticky-note', label: t('subscriptions.notesLabel'), value: subscription.notes || '', multiline: true },
  ];
}

/**
 * DAS ABO ALS LESEBLATT (R24, E1; Critique G4-Budget-P2-4). Bis R24 oeffnete
 * der Tipp auf die Zeile das Formular, den Namen fokussiert - am Telefon mit
 * der Tastatur ueber dem halben Blatt. Jetzt zuerst das Blatt mit Betrag,
 * Turnus, naechster Zahlung, Zahlart und Konto; Bearbeiten ist der EINE
 * Primaerknopf (withPrimaryEdit), "Verlaengert" steht sekundaer davor, solange
 * das Abo eine naechste Zahlung hat. Bei `budget: read` (P1-Muster) dasselbe
 * Blatt ohne Fuss.
 */
function openSubscriptionReadView(subscription, { editable = false } = {}) {
  const leave = (next) => async ({ close } = {}) => {
    await (close ?? closeDetailView)({ force: true });
    await next();
  };
  const actions = editable ? withPrimaryEdit([
    !isCompleted(subscription) && {
      id: 'subscription-read-renew',
      label: t('subscriptions.markRenewed'),
      icon: 'calendar-check',
      variant: 'secondary',
      onClick: leave(() => renewSubscription(subscription)),
    },
  ], {
    id: 'subscription-read-edit',
    label: t('common.edit'),
    onClick: leave(() => openSubscriptionModal(subscription)),
  }) : [];
  return openDetailView({
    title: subscription.name,
    key: `subscription:${subscription.id}`,
    accentColor: subscription.brand_color || subscription.category_color || 'var(--module-budget)',
    size: 'sm',
    sections: subscriptionReadSections(subscription),
    actions,
  });
}

/**
 * Kategorie und Zahlungsart im Abo-Dialog: EIN Helfer fuer Beschriftung und
 * Optionen, beim Oeffnen wie beim Neuaufbau nach "die gewaehlte gibt es nicht
 * mehr" - damit beide nicht auseinanderlaufen (#1909, Codex an #1994).
 */
const META_COMBOBOXES = {
  'subscription-category': {
    label: 'subscriptions.categoryLabel',
    placeholder: 'subscriptions.categorySearchPlaceholder',
    items: () => [
      { value: '', label: t('subscriptions.uncategorized') },
      ...state.meta.categories.map((item) => ({ value: item.id, label: categoryLabel(item) })),
    ],
  },
  'subscription-method': {
    label: 'subscriptions.paymentMethodLabel',
    placeholder: 'subscriptions.paymentMethodSearchPlaceholder',
    items: () => [
      { value: '', label: t('subscriptions.unspecified') },
      ...state.meta.payment_methods.map((item) => ({ value: item.id, label: paymentMethodLabel(item) })),
    ],
  },
};

function metaComboboxMarkup(id, value = '', { without = null } = {}) {
  const config = META_COMBOBOXES[id];
  const items = config.items().filter((item) => without === null || String(item.value) !== without);
  return comboboxMarkup({ id, label: t(config.label), items, value, placeholder: t(config.placeholder) });
}

/**
 * Die im Abo-Dialog GEWAEHLTE Kategorie oder Zahlungsart ist weg (#1909): der
 * Dialog bleibt mit der Eingabe offen. Die Seite laedt ueber das normale Laden
 * mit Ladenummer neu (ein Filter auf die geloeschte geht vorher auf "alle"),
 * dann wird die Auswahl ueber denselben Helfer wie beim Oeffnen aus dem
 * frischen Stand gebaut, steht auf "keine" und traegt den Fokus. Scheitert
 * das Laden, faellt wenigstens die geloeschte aus der Auswahl. Eine andere
 * Seiteninstanz bleibt unberuehrt.
 */
async function offerCurrentMeta(panel, id, reason, owner) {
  const goneId = String(panel.querySelector(`#${id}`)?.value ?? '');
  if (!isCurrentOwner(owner)) return;
  resetGoneFilter(reason, goneId);
  await reload(undefined, { owner, quiet: true });
  if (!isCurrentOwner(owner)) return;
  const root = panel.querySelector(`[data-combobox="${id}"]`);
  if (!root) return;
  root.insertAdjacentHTML('afterend', metaComboboxMarkup(id, '', { without: goneId }));
  root.remove();
  wireCombobox(panel, id);
  panel.querySelector(`#${id}-search`)?.focus();
}

/**
 * DAS KONTO DES ABOS (#1277): die Vorgabe fuer jede Buchung, die es bucht.
 * Zur Wahl stehen die aktiven Konten; ein archiviertes nur, wenn es das
 * gewaehlte ist - dann bucht das Abo ohne Konto (Entscheidung zu #1277), und
 * der Hinweis darunter sagt es. Ohne Konten gibt es das Feld nicht, wie im
 * Buchungsdialog.
 */
function accountFieldHtml(subscription) {
  const accounts = state.meta.accounts ?? [];
  if (!accounts.length) return '';
  const current = subscription?.account_id ?? null;
  const options = accounts
    .filter((account) => !account.archived || account.id === current)
    .map((account) => `<option value="${account.id}"${account.id === current ? ' selected' : ''}${account.archived ? ' data-archived="true"' : ''}>${esc(account.archived
      ? t('subscriptions.accountArchivedOption', { name: account.name })
      : account.name)}</option>`)
    .join('');
  const archived = accounts.some((account) => account.id === current && account.archived);
  return `
        <div class="form-group" data-subscription-account-field>
          <label class="form-label" for="subscription-account-id">${t('budget.accountLabel')}</label>
          <select class="form-input" id="subscription-account-id"
                  aria-describedby="subscription-account-id-hint subscription-account-id-archived">
            <option value=""${current === null ? ' selected' : ''}>${t('budget.noAccount')}</option>${options}
          </select>
          <p class="form-hint" id="subscription-account-id-hint">${t('subscriptions.accountHint')}</p>
          <p class="form-hint" id="subscription-account-id-archived"${archived ? '' : ' hidden'}>${t('subscriptions.accountArchivedHint')}</p>
        </div>`;
}

/** Der Archiv-Hinweis folgt der Wahl: er steht, solange ein archiviertes gewaehlt ist. */
function wireAccountField(panel) {
  const select = panel.querySelector('#subscription-account-id');
  if (!select) return;
  select.addEventListener('change', () => {
    const hint = panel.querySelector('#subscription-account-id-archived');
    if (hint) hint.hidden = select.selectedOptions?.[0]?.dataset.archived !== 'true';
  });
}

/**
 * DIE SICHTBARKEIT DES ABOS (#1701): dieselbe Wahl unter derselben Bedingung
 * wie im Buchungsdialog (budget.js) - nur im persoenlichen Budget-Modus, im
 * geteilten sieht ohnehin jeder alles. Ein neues Abo steht auf "geteilt" wie
 * eine neue Buchung; die Buchungen des Abos folgen seiner Stufe.
 */
function visibilityFieldHtml(subscription) {
  if (state.meta.budget_mode !== 'personal') return '';
  const level = subscription?.visibility === 'private' ? 'private' : 'shared';
  return `
        <div class="form-group">
          <label class="form-label" for="subscription-visibility">${t('budget.visibilityLabel')}</label>
          <select class="form-input" id="subscription-visibility" aria-describedby="subscription-visibility-hint">
            ${['private', 'shared'].map((option) => `<option value="${option}"${option === level ? ' selected' : ''}>${t(`budget.visibility_${option}`)}</option>`).join('')}
          </select>
          <p class="form-hint" id="subscription-visibility-hint">${t(`subscriptions.visibilityHint_${level}`)}</p>
        </div>`;
}

/**
 * Das gewaehlte Konto gibt es nicht mehr (#1277): wie bei Kategorie und
 * Zahlungsart bleibt der Dialog offen, die Seite laedt neu, und die Wahl kommt
 * aus dem frischen Stand, auf "Kein Konto".
 */
async function offerCurrentAccounts(panel, owner) {
  const goneId = Number(panel.querySelector('#subscription-account-id')?.value) || null;
  if (!isCurrentOwner(owner)) return;
  await reload(undefined, { owner, quiet: true });
  if (!isCurrentOwner(owner)) return;
  const field = panel.querySelector('[data-subscription-account-field]');
  if (!field) return;
  state.meta.accounts = (state.meta.accounts ?? []).filter((account) => account.id !== goneId);
  field.insertAdjacentHTML('afterend', accountFieldHtml(null));
  field.remove();
  wireAccountField(panel);
  panel.querySelector('#subscription-account-id')?.focus();
}

export function openSubscriptionModal(subscription = null) {
  // Der Riegel steht VOR jeder Vorbereitung: der Anlegeweg entfaellt ganz, ein
  // bestehendes Abo geht als Leseansicht auf (P1-Muster wie openNoteModal).
  if (readOnly()) {
    if (subscription) openSubscriptionReadView(subscription);
    return;
  }
  const edit = Boolean(subscription);
  // Jedes Abo trägt seine eigene Währung; das Betragsfeld richtet sich danach
  // und wird beim Wechsel der Währungs-Combobox nachgezogen.
  const formCurrency = subscription?.currency || state.settings.base_currency;
  const formCycle = subscription?.billing_cycle || 'monthly';
  const initialLogo = subscription?.logo_data || '';
  const initialName = subscription?.name || '';

  // Sekundärfelder: Organisation + Service hinter „Weitere Einstellungen".
  // Beim Bearbeiten automatisch geöffnet, falls bereits Werte abseits der Defaults gesetzt sind.
  const advancedOpen = edit && (
    !!subscription.category_id
    || !!subscription.payment_method_id
    || (!!subscription.brand_color && subscription.brand_color !== SUBSCRIPTION_COLOR_DEFAULT)
    || !!subscription.notes
    || subscription.enabled === false
    || (state.meta.budget_mode === 'personal' && subscription.visibility === 'private')
  );

  const advancedFieldsHtml = `
      <section class="subscription-form__section">
        <h3 class="subscription-form__title">${t('subscriptions.organizationDetails')}</h3>
        ${visibilityFieldHtml(subscription)}
        <div class="subscription-form__organization-grid">
          ${metaComboboxMarkup('subscription-category', subscription?.category_id || '')}
          ${metaComboboxMarkup('subscription-method', subscription?.payment_method_id || '')}
          <div class="form-group subscription-form__color">
            <span class="form-label" id="subscription-color-label">${t('subscriptions.brandColorLabel')}</span>
            ${colorPickerHtml({ id: 'subscription-color', value: subscription?.brand_color || SUBSCRIPTION_COLOR_DEFAULT, labelledBy: 'subscription-color-label', options: subscriptionColorOptions() })}
          </div>
        </div>
      </section>

      <section class="subscription-form__section">
        <h3 class="subscription-form__title">${t('subscriptions.serviceDetails')}</h3>
        <div class="form-group">
          <label class="form-label" for="subscription-account">${t('subscriptions.accountUsernameLabel')}</label>
          <input class="form-input" type="text" id="subscription-account" maxlength="200"
                 autocomplete="off" spellcheck="false" value="${esc(subscription?.account_username || '')}">
          <p class="form-hint">${t('subscriptions.accountUsernameHint')}</p>
        </div>
        <div class="form-group">
          <label class="form-label" for="subscription-notes">${t('subscriptions.notesLabel')}</label>
          <textarea class="form-input" id="subscription-notes" rows="3">${esc(subscription?.notes || '')}</textarea>
        </div>
        ${formSwitchRowHtml({
          label: t('subscriptions.enabledLabel'), checked: subscription?.enabled !== false,
          hint: t('subscriptions.enabledHint'), hintId: 'subscription-enabled-hint', attrs: { id: 'subscription-enabled' },
        })}
      </section>`;

  const content = `
    <form id="subscription-form" class="subscription-form" novalidate>
      <section class="subscription-form__section subscription-form__identity">
        ${/* DAS LOGO IST EIN BEDIENELEMENT (Critique R24 G4-Budget-P3-3,
             Baustein `.media-picker`): die Kachel IST die Dateiwahl, das
             Abzeichen an ihrer Ecke sagt es - "Logo hochladen" als zweite
             Beschriftung darunter ist weg. "Logo finden" bleibt eine eigene
             Handlung (Suche im Netz), als ruhiger Knopf darunter. */ ''}
        <div class="subscription-logo-tools">
          <span class="media-picker">
            <button type="button" class="subscription-logo-picker" id="subscription-logo-button" aria-label="${esc(t('subscriptions.logoLabel'))}">
              <span id="subscription-logo-preview">
                ${initialLogo
                  ? `<img src="${esc(initialLogo)}" alt="">`
                  : `<strong>${esc(initialName.slice(0, 2).toUpperCase() || '+')}</strong>`}
              </span>
            </button>
            ${mediaPickerBadgeHtml()}
          </span>
          <input class="sr-only" id="subscription-logo" type="file" accept="image/png,image/jpeg,image/webp,image/svg+xml"
                 aria-label="${esc(t('subscriptions.logoLabel'))}" tabindex="-1">
          <button class="btn btn--secondary btn--sm subscription-find-logo-btn" type="button" id="subscription-find-logo">
            <i data-lucide="scan-search" aria-hidden="true"></i>${t('subscriptions.findLogo')}
          </button>
        </div>
        <div class="subscription-form__identity-fields">
          <div class="form-group">
            <label class="form-label" for="subscription-name">${t('subscriptions.nameLabel')}${REQUIRED_MARK}</label>
            <input class="form-input" id="subscription-name" maxlength="200" required value="${esc(initialName)}">
          </div>
          <div class="form-group">
            <label class="form-label" for="subscription-description">${t('subscriptions.descriptionLabel')}</label>
            <input class="form-input" id="subscription-description" maxlength="5000" value="${esc(subscription?.description || '')}">
          </div>
        </div>
      </section>

      <section class="subscription-form__section">
        <h3 class="subscription-form__title">${t('subscriptions.billingDetails')}</h3>
        <div class="subscription-form__billing-grid">
          ${/* DIE WAEHRUNG STEHT IM BETRAG (R22 D9, Critique R24
               G4-Budget-P1-1): bis R24 eine eigene Such-Combobox mit Lupe
               ("EUR · Euro") neben dem Betrag. Jetzt die Wahl als Code im
               Suffix des Felds, derselbe Baustein wie Ausgabe und Serie. */ ''}
          <div class="form-group">
            <label class="form-label" for="subscription-amount">${t('subscriptions.amountLabel')}${REQUIRED_MARK}</label>
            ${amountFieldHtml({ id: 'subscription-amount', currency: formCurrency, value: subscription?.amount ?? '', currencies: CURRENCY_CODES, currencyId: 'subscription-currency', currencyName: 'currency' })}
          </div>
          ${/* DER ZYKLUS IST EIN SATZ (Critique R24 G4-Budget-P3-3): "Alle [1] [Monat]"
               statt "Abrechnungszyklus" als Suchfeld und daneben "Alle" ueber einer
               nackten 1 (utils/interval-sentence.js). Die Woerter der Wahl folgen der
               Zahl und kommen aus dem Satz der Einheit (S4, F1). */ ''}
          <div class="form-group subscription-form__cycle">
            <span class="form-label" id="subscription-cycle-label">${t('subscriptions.billingCycleLabel')}</span>
            ${intervalSentenceHtml({
              units: { id: 'subscription-cycle', options: state.meta.billing_cycles, selected: formCycle },
              labelledBy: 'subscription-cycle-label',
              count: subscription?.cycle_interval || 1,
              countHtml: `<input class="form-input" id="subscription-interval" type="number" min="1" max="365" step="1" inputmode="numeric" value="${esc(String(subscription?.cycle_interval || 1))}" aria-labelledby="subscription-cycle-label">`,
            })}
          </div>
          ${/* DIE NAECHSTE ZAHLUNG GEHOERT ZUR ABRECHNUNG (Critique R24
               G4-Budget-P3-3): sie hing unter dem Erinnerungs-Schalter, weit
               weg von Betrag und Turnus, aus denen sie folgt. */ ''}
          <div class="form-group subscription-form__next">
            <label class="form-label" for="subscription-next-date">${t('subscriptions.nextPaymentLabel')}${REQUIRED_MARK}</label>
            <yuvomi-datepicker id="subscription-next-date" type="date" required
                   value="${esc(subscription?.next_payment_date || todayKey())}"></yuvomi-datepicker>
            ${isCompleted(subscription) ? `<p class="form-hint" id="subscription-next-date-hint">${t('subscriptions.nextPaymentCompletedHint')}</p>` : ''}
          </div>
        </div>
        ${accountFieldHtml(subscription)}
      </section>

      <section class="subscription-form__section">
        <h3 class="subscription-form__title">${t('subscriptions.renewalDetails')}</h3>
        ${toggleRowHtml({
          label: t('subscriptions.reminderEnabledLabel'), control: 'switch',
          checked: subscription?.reminder_enabled !== false,
          attrs: { id: 'subscription-reminder-enabled' },
        })}
        <div class="form-group">
          <label class="form-label" for="subscription-reminder">${t('subscriptions.reminderDaysLabel')}</label>
          <input class="form-input" id="subscription-reminder" type="number" min="0" max="365" step="1" value="${subscription?.reminder_days ?? DEFAULT_REMINDER_DAYS}"${subscription?.reminder_enabled === false ? ' disabled' : ''}>
        </div>
        <div class="form-group">
          <label class="form-label" for="subscription-end-type">${t('subscriptions.endLabel')}</label>
          <select class="form-input" id="subscription-end-type">
            <option value="never">${t('subscriptions.endNever')}</option>
            <option value="on_date">${t('subscriptions.endOnDate')}</option>
            <option value="after_count">${t('subscriptions.endAfterCount')}</option>
          </select>
        </div>
        <div class="form-grid-2">
          <div class="form-group" id="subscription-end-date-field" ${(subscription?.end_type === 'on_date') ? '' : 'hidden'}>
            <label class="form-label" for="subscription-end-date">${t('subscriptions.endDateLabel')}</label>
            <yuvomi-datepicker id="subscription-end-date" type="date"
                   value="${esc(subscription?.end_date || '')}"></yuvomi-datepicker>
          </div>
          <div class="form-group" id="subscription-end-count-field" ${(subscription?.end_type === 'after_count') ? '' : 'hidden'}>
            <label class="form-label" for="subscription-end-count">${t('subscriptions.endCountLabel')}</label>
            <input class="form-input" id="subscription-end-count" type="number" min="1" max="1200" step="1" value="${subscription?.occurrence_count ?? ''}">
          </div>
        </div>
      </section>

      ${advancedSection(advancedFieldsHtml, { open: advancedOpen, hint: t('subscriptions.moreDetailsHint') })}
      <div class="modal-panel__footer subscriptions-modal-footer">
        ${edit ? `<button type="button" class="btn btn--danger-outline" id="subscription-delete"
                aria-label="${esc(t('common.deleteNamed', { name: subscription.name }))}">
          <i data-lucide="trash-2" class="icon-md" aria-hidden="true"></i>${esc(t('common.delete'))}
        </button>` : ''}
        <button class="btn btn--secondary" type="button" id="subscription-cancel">${t('common.cancel')}</button>
        <button class="btn btn--primary" type="submit">${edit ? t('common.save') : t('common.add')}</button>
      </div>
    </form>
  `;
  openModal({
    staged: !edit, // Buehne zuerst, Felder nach dem ersten Bild (modal.js, R21 a6)
    title: edit ? t('subscriptions.editTitle') : t('subscriptions.addTitle'),
    initialFocus: edit ? 'edit' : 'first-field',
    content,
    size: 'lg',
    onSave(panel) {
      wireColorPicker(panel);
      let searchedLogoData = null;
      const logoPreview = panel.querySelector('#subscription-logo-preview');
      const showLogo = (data) => {
        logoPreview.replaceChildren();
        if (data) {
          logoPreview.insertAdjacentHTML('afterbegin', `<img src="${esc(data)}" alt="">`);
        } else {
          logoPreview.insertAdjacentHTML('afterbegin', `<strong>${esc(panel.querySelector('#subscription-name').value.slice(0, 2).toUpperCase() || '+')}</strong>`);
        }
      };
      // Die Kachel oeffnet die Dateiwahl (media-picker): das Feld selbst ist
      // versteckt und nicht im Tab-Lauf.
      panel.querySelector('#subscription-logo-button').addEventListener('click', () => panel.querySelector('#subscription-logo').click());
      // Ein Abo darf 0 kosten (Gratis-Tarif, Server prüft amount >= 0): das
      // Speichern prueft deshalb mit `sign: 'nonNegative'`.
      panel.querySelector('#subscription-currency').addEventListener('change', (event) => {
        setAmountCurrency(panel.querySelector('#subscription-amount'), event.target.value);
      });
      wireCombobox(panel, 'subscription-category');
      wireCombobox(panel, 'subscription-method');
      wireAccountField(panel);
      const visibility = panel.querySelector('#subscription-visibility');
      visibility?.addEventListener('change', () => {
        panel.querySelector('#subscription-visibility-hint').textContent = t(`subscriptions.visibilityHint_${visibility.value}`);
      });
      const reminderEnabled = panel.querySelector('#subscription-reminder-enabled');
      reminderEnabled.addEventListener('change', () => {
        panel.querySelector('#subscription-reminder').disabled = !reminderEnabled.checked;
      });
      // Ende-Bedingung (#594): das passende Zusatzfeld ein-/ausblenden.
      const endTypeSelect = panel.querySelector('#subscription-end-type');
      endTypeSelect.value = subscription?.end_type || 'never';
      const syncEndFields = () => {
        panel.querySelector('#subscription-end-date-field').hidden = endTypeSelect.value !== 'on_date';
        panel.querySelector('#subscription-end-count-field').hidden = endTypeSelect.value !== 'after_count';
      };
      endTypeSelect.addEventListener('change', syncEndFields);
      syncEndFields();
      panel.querySelector('#subscription-cancel').addEventListener('click', closeModal);
      // EINE ZEILENBEDIENUNG (R14 P8): Loeschen steht hier im Fuss, nicht mehr
      // als Papierkorb an der Zeile. Erst schliessen, dann fragen - die
      // Rueckfrage steht dann nicht ueber einem offenen Formular.
      panel.querySelector('#subscription-delete')?.addEventListener('click', () => {
        closeModal({ force: true });
        void deleteSubscription(subscription);
      });
      panel.querySelector('#subscription-logo').addEventListener('change', async (event) => {
        const file = event.target.files[0];
        if (!file) return;
        try {
          searchedLogoData = await fileToDataUrl(file);
          showLogo(searchedLogoData);
        } catch (err) {
          event.target.value = '';
          window.yuvomi?.showToast(errorText(err), 'danger');
        }
      });
      panel.querySelector('#subscription-name').addEventListener('input', () => {
        if (!logoPreview.querySelector('img')) showLogo(null);
      });
      panel.querySelector('#subscription-find-logo').addEventListener('click', async () => {
        openLogoPickerModal(panel, subscription?.website_url || panel.querySelector('#subscription-name').value.trim(), (logoData) => {
          searchedLogoData = logoData;
          showLogo(searchedLogoData);
          window.yuvomi?.showToast(t('subscriptions.logoFound'), 'success');
        });
      });
      panel.querySelector('#subscription-form').addEventListener('submit', async (event) => {
        event.preventDefault();
        await saveSubscription(panel, subscription, searchedLogoData);
      });
    },
  });
}

/* Muss dem accept-Attribut des Logo-Felds entsprechen (test/test-image-picker.js
 * hält beide deckungsgleich). Bewusst NICHT pickCroppedImage() (#901): ein Logo
 * lebt von Transparenz und darf SVG sein - der Zuschnitt gibt immer ein
 * 256-px-JPEG zurück und zerstörte beides. */
const LOGO_ACCEPTED_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/svg+xml'];

async function fileToDataUrl(file) {
  if (!file) return null;
  if (!LOGO_ACCEPTED_TYPES.includes(file.type)) throw new PageProblem(t('subscriptions.logoTypeError'));
  if (file.size > 500000) throw new PageProblem(t('subscriptions.logoTooLarge'));
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    // Roh weitergereicht war das der ProgressEvent - `err.message` im Toast
    // des Aufrufers zeigte dann `undefined`.
    reader.onerror = () => reject(new PageProblem(t('documents.fileReadError')));
    reader.readAsDataURL(file);
  });
}

async function saveSubscription(panel, existing, searchedLogoData = null) {
  if (readOnly()) return;
  const dateInput = panel.querySelector('#subscription-next-date');
  const currencyInput = panel.querySelector('#subscription-currency');
  // Alle Feldfehler auf einmal, Fokus aufs erste im Bild (Critique R19): bis
  // hierher brach die Pruefung beim ersten ab, ein Fehler je Klick.
  const fieldErrors = [];
  const nextDateValid = isDateInputValid(dateInput.value);
  if (!nextDateValid) {
    // Fehler am Feld statt als ortloser Toast (geteiltes Muster, Critique P1).
    fieldErrors.push([dateInput, t('subscriptions.invalidDate')]);
  }
  if (!currencyInput.value) {
    // Seit R24 eine Wahl im Suffix des Betrags - leer kann sie nur ein
    // Nachbau sein; die Meldung steht dann an ihr.
    fieldErrors.push([currencyInput, t('subscriptions.currencyRequired')]);
  }
  // Ende-Bedingung (#594): nur das aktive Zusatzfeld liefert einen Wert.
  const endType = panel.querySelector('#subscription-end-type').value;
  const staysCompleted = isCompleted(existing) && !panel.querySelector('#subscription-enabled').checked;
  let endDate = null;
  let occurrenceCount = null;
  if (endType === 'on_date') {
    const endDateInput = panel.querySelector('#subscription-end-date');
    if (!isDateInputValid(endDateInput.value)) {
      fieldErrors.push([endDateInput, t('subscriptions.invalidDate')]);
    } else {
      endDate = parseDateInput(endDateInput.value);
      // Dieselbe Regel wie der Server (endConfigErrors), vor dem Absenden und am
      // Feld statt als Toast (Review-Runde 1 zu #2010). Ein abgeschlossenes Abo
      // mit Enddatum steht immer nach seinem Ende: wer es wieder aufnimmt,
      // braucht ein spaeteres. Bleibt es abgeschlossen, gilt der Vergleich nicht.
      if (nextDateValid && !staysCompleted && endDate < parseDateInput(dateInput.value)) {
        fieldErrors.push([endDateInput, t('subscriptions.errorEndBeforeNextPayment')]);
      }
    }
  } else if (endType === 'after_count') {
    const countInput = panel.querySelector('#subscription-end-count');
    const count = Number(countInput.value);
    if (!Number.isInteger(count) || count < 1) {
      fieldErrors.push([countInput, t('subscriptions.endCountInvalid')]);
    } else if (!staysCompleted && count <= Number(existing?.occurrences_done || 0)) {
      fieldErrors.push([countInput, t('subscriptions.errorOccurrenceCountTooLow')]);
    }
    occurrenceCount = count;
  }
  // Der Betrag als TEXT (D1): "1.200" unter de ist abgewiesen und benannt,
  // nie still 1,2. Ein Bestandsbetrag neben dem Raster bleibt unangetastet
  // speicherbar (`original`), ein neuer nicht. Ohne Waehrung gibt es kein
  // Raster - dann meldet fuer die Stellen nur das Waehrungsfeld. Leer meldet
  // `constraintErrors` unten (Pflichtfeld).
  const amountInput = panel.querySelector('#subscription-amount');
  const targetCurrency = currencyInput.value.trim().toUpperCase();
  const amountProblem = amountFieldError(amountInput, targetCurrency || state.settings.base_currency, {
    sign: 'nonNegative',
    original: existing?.amount ?? null,
    originalCurrency: existing?.currency ?? null,
    precision: Boolean(targetCurrency),
  });
  if (amountProblem) fieldErrors.push(amountProblem);
  // KEINE BROWSER-BLASEN (Critique R21): `novalidate`, die Regeln des Markups melden sich am Feld (constraintErrors, components/modal.js).
  // Was die eigenen Pruefungen oben schon nennen, steht nicht doppelt.
  for (const entry of constraintErrors(panel.querySelector('#subscription-form'))) {
    if (!fieldErrors.some(([field]) => field === entry[0])) fieldErrors.push(entry);
  }
  if (reportFieldErrors(fieldErrors)) return;

  const submit = panel.querySelector('[type="submit"]');
  submit.disabled = true;
  // Der Dialog und die Seite dieser Handlung, vor jeder Anfrage gemerkt (reportError).
  const dialog = captureModalContext();
  const owner = pageOwner();
  try {
    const file = panel.querySelector('#subscription-logo').files[0];
    const logoData = searchedLogoData || (file ? await fileToDataUrl(file) : existing?.logo_data || null);
    const payload = {
      name: panel.querySelector('#subscription-name').value.trim(),
      description: panel.querySelector('#subscription-description').value.trim() || null,
      amount: parseAmountInput(panel.querySelector('#subscription-amount').value),
      currency: panel.querySelector('#subscription-currency').value.trim().toUpperCase(),
      billing_cycle: panel.querySelector('#subscription-cycle').value,
      cycle_interval: Number(panel.querySelector('#subscription-interval').value),
      next_payment_date: parseDateInput(dateInput.value),
      reminder_days: Number(panel.querySelector('#subscription-reminder').value),
      reminder_enabled: panel.querySelector('#subscription-reminder-enabled').checked,
      category_id: Number(panel.querySelector('#subscription-category').value) || null,
      payment_method_id: Number(panel.querySelector('#subscription-method').value) || null,
      website_url: existing?.website_url || null,
      brand_color: panel.querySelector('#subscription-color').value,
      logo_data: logoData,
      notes: panel.querySelector('#subscription-notes').value.trim() || null,
      // Konto/Benutzername des Dienstes (#1004) - unverschluesselt und
      // absichtlich KEIN Passwortfeld; die Grenze steht in docs/SCOPE.md.
      account_username: panel.querySelector('#subscription-account').value.trim() || null,
      enabled: panel.querySelector('#subscription-enabled').checked,
      end_type: endType,
      end_date: endDate,
      occurrence_count: occurrenceCount,
    };
    // Konto und Sichtbarkeit nur, wenn der Dialog sie zeigt (#1277, #1701):
    // ohne Kontofeld bleibt das Konto des Abos stehen, im geteilten Modus
    // entscheidet der Server die Sichtbarkeit.
    const accountSelect = panel.querySelector('#subscription-account-id');
    if (accountSelect) payload.account_id = Number(accountSelect.value) || null;
    const visibilitySelect = state.meta.budget_mode === 'personal' ? panel.querySelector('#subscription-visibility') : null;
    if (visibilitySelect) payload.visibility = visibilitySelect.value === 'private' ? 'private' : 'shared';
    if (existing) await api.put(`/budget/subscriptions/${existing.id}`, payload);
    else await api.post('/budget/subscriptions', payload);
    // Nur DIESEN Dialog: einen inzwischen geoeffneten anderen laesst die
    // spaete Antwort stehen (#1997).
    await closeModal({ force: true, context: dialog });
    if (await reloadAfterSave(() => reload(undefined, { motion: true, owner }))) refocusAfterRender();
    window.yuvomi?.showToast(t(existing ? 'subscriptions.savedToast' : 'subscriptions.addedToast'), 'success');
  } catch (err) {
    const goneSelect = selectedMetaGone(err);
    if (goneSelect) {
      window.yuvomi?.showToast(errorText(err), 'danger');
      await offerCurrentMeta(panel, goneSelect, err.data.reason, owner);
      return;
    }
    if (err?.data?.reason === 'subscriptions_account_not_found') {
      window.yuvomi?.showToast(errorText(err), 'danger');
      await offerCurrentAccounts(panel, owner);
      return;
    }
    reportError(err, { owner, dialog });
  } finally {
    submit.disabled = false;
  }
}

function logoOptionsMarkup(options) {
  return options.length ? options.map((option, index) => `
    <button class="subscriptions-logo-option" type="button" data-logo-index="${index}" aria-label="${esc(t('subscriptions.useLogo'))}">
      <img src="${esc(option.logo_data)}" alt="">
      <span>${esc(t('subscriptions.logoSourceWebsite'))}</span>
    </button>
  `).join('') : `<p class="subscriptions-logo-empty">${t('subscriptions.logoSearchEmpty')}</p>`;
}

function openLogoPickerModal(panel, initialQuery, onSelect) {
  // Der Knopf "Logo suchen", der den Picker oeffnet - dorthin geht der Fokus zurueck.
  const opener = document.activeElement;
  const stale = panel.querySelector('.subscriptions-logo-picker-modal');
  stale?._releaseBackground?.();
  stale?.remove();
  panel.insertAdjacentHTML('beforeend', `
    <div class="subscriptions-logo-picker-modal" role="dialog" aria-modal="true" aria-labelledby="subscription-logo-picker-title">
      <div class="subscriptions-logo-picker-panel">
        <div class="subscriptions-logo-picker-head" data-dialog-actions>
          <h3 id="subscription-logo-picker-title">${t('subscriptions.logoSearchTitle')}</h3>
          <button class="btn btn--secondary btn--icon" type="button" id="subscription-logo-picker-close" aria-label="${esc(t('common.close'))}">
            <i data-lucide="x" aria-hidden="true"></i>
          </button>
        </div>
        <form id="subscription-logo-search-form" class="subscriptions-logo-search-form">
          <label class="form-label" for="subscription-logo-search-input">${t('subscriptions.logoSearchLabel')}</label>
          <div class="subscriptions-logo-search" data-dialog-actions>
            <input class="form-input" id="subscription-logo-search-input" inputmode="url"
                   placeholder="${esc(t('subscriptions.logoSearchPlaceholder'))}" value="${esc(initialQuery || '')}">
            <button class="btn btn--primary" type="submit">
              <i data-lucide="search" aria-hidden="true"></i>${t('subscriptions.searchLogo')}
            </button>
          </div>
        </form>
        <div class="subscriptions-logo-results" id="subscription-logo-results">
          <p class="subscriptions-logo-empty">${t('subscriptions.findLogoHint')}</p>
        </div>
      </div>
    </div>
  `);
  const overlay = panel.querySelector('.subscriptions-logo-picker-modal');
  // Das Abo-Formular darunter ist gesperrt, solange der Picker offen ist
  // (utils/background-inert.js); freigegeben VOR der Fokus-Rueckgabe.
  overlay._releaseBackground = inertOutside(overlay);
  const results = overlay.querySelector('#subscription-logo-results');
  const input = overlay.querySelector('#subscription-logo-search-input');
  let options = [];
  const close = () => {
    // Mit dem Picker ginge das fokussierte Suchfeld weg, und der Fokus fiele auf
    // body - aus der Fokusfalle des Abo-Formulars heraus (Codex-Review zu #2055).
    const hadFocus = overlay.contains(document.activeElement);
    overlay._releaseBackground();
    overlay.remove();
    if (!hadFocus) return;
    const target = opener?.isConnected ? opener : panel.querySelector('#subscription-find-logo');
    target?.focus();
  };
  // Der Picker liegt ueber dem Abo-Formular; die Zurueck-Geste meint ihn (#871).
  attachOverlay(overlay, close);
  const search = async () => {
    const query = input.value.trim();
    if (!query) return;
    const button = overlay.querySelector('[type="submit"]');
    button.disabled = true;
    setHtml(results, `<p class="subscriptions-logo-empty">${t('subscriptions.logoSearching')}</p>`);
    try {
      const response = await api.post('/budget/subscriptions/logo-search', { query });
      options = response.data?.options || [];
      setHtml(results, logoOptionsMarkup(options));
    } catch (err) {
      const message = errorSentence(err, 'subscriptions.logoSearchError');
      options = [];
      setHtml(results, `<p class="subscriptions-logo-empty">${esc(message)}</p>`);
      window.yuvomi?.showToast(message, 'danger');
    } finally {
      button.disabled = false;
      if (window.lucide) window.lucide.createIcons({ el: overlay });
    }
  };
  overlay.addEventListener('click', (event) => {
    if (event.target === overlay) close();
    const option = event.target.closest('[data-logo-index]');
    if (!option) return;
    const selected = options[Number(option.dataset.logoIndex)];
    if (!selected) return;
    onSelect(selected.logo_data);
    close();
  });
  overlay.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      // Esc meint den Picker, nicht das Abo-Formular darunter (onEscape in
      // modal.js wertet preventDefault als "schon erledigt").
      event.preventDefault();
      close();
    }
  });
  overlay.querySelector('#subscription-logo-picker-close').addEventListener('click', close);
  overlay.querySelector('#subscription-logo-search-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    await search();
  });
  if (window.lucide) window.lucide.createIcons({ el: overlay });
  setTimeout(() => input.focus(), 50);
}

// Eine Zahlung zu buchen schiebt das Faelligkeitsdatum und legt einen
// Budget-Eintrag an. Bis R23 fragte die Aktion deshalb an BEIDEN Wegen nach
// (Geste wie Knopf), weil sich nichts zurueckholen liess - die Rueckfrage stand
// an der Stelle eines Rueckwegs (N4). Seit R23 (D6) nimmt "Rueckgaengig" im
// Toast die Zahlung am Server ECHT zurueck (POST /renew/undo: Datum, Zaehler,
// Abschluss, beide Buchungen), und keiner der beiden Wege fragt mehr.
async function renewSubscription(subscription) {
  if (readOnly()) return;
  // Ein abgeschlossenes Abo hat keine naechste Zahlung (#2011): weder Knopf
  // noch Geste tun etwas, der Server lehnt es ohnehin ab.
  if (isCompleted(subscription)) return;
  const owner = pageOwner();
  try {
    const response = await api.post(`/budget/subscriptions/${subscription.id}/renew`, {});
    if (await reloadAfterSave(() => reload(undefined, { motion: true, owner }))) refocusAfterRender();
    const completed = response.data?.status === 'completed';
    const message = completed
      ? t('subscriptions.completedNamed', { name: subscription.name })
      : t('subscriptions.renewedNamed', { name: subscription.name, date: dateText(response.data?.next_payment_date, { weekday: true }) });
    if (!response.undo?.token) {
      window.yuvomi?.showToast(message, 'success');
      return;
    }
    offerUndo({
      message,
      undo: async () => {
        await api.post(`/budget/subscriptions/${subscription.id}/renew/undo`, response.undo);
        if (await reload(undefined, { motion: true, owner })) refocusAfterRender();
      },
      onError: async (err) => {
        await reportError(err, { owner });
        if (isCurrentOwner(owner)) await reload(undefined, { owner, quiet: true });
      },
    });
  } catch (err) {
    await reportError(err, { owner });
    // Schon abgeschlossen (#2011): die Karte war veraltet - ein anderes
    // Haushaltsmitglied hat die letzte Zahlung gebucht. Neu laden, damit der
    // Knopf verschwindet; der Satz steht schon da.
    if (err?.status !== 403 && err?.data?.reason === 'subscriptions_subscription_completed' && isCurrentOwner(owner)) {
      if (await reload(undefined, { owner, quiet: true })) refocusAfterRender();
    }
  }
}

/**
 * Abos in der Ruecknahmefrist: lokal schon weg, am Server noch da, bis ihr
 * Loeschen nach der Frist des Toasts laeuft. Ein Neuladen in dieser Zeit
 * (Speichern eines anderen Abos) holte sie sonst zurueck.
 */
const pendingDeletes = new Set();

// LOESCHEN MIT RUECKGAENGIG STATT RUECKFRAGE (Critique R23, D6). Das Loeschen
// laeuft erst, wenn die Frist des Toasts endet (`scheduleUndoableDelete`):
// bis dahin ist am Server nichts geschehen - auch nicht an Erinnerungen und
// der Buchung der naechsten Zahlung, die mit dem Abo gehen.
async function deleteSubscription(subscription) {
  if (readOnly()) return;
  const owner = pageOwner();
  const id = subscription.id;
  pendingDeletes.add(id);
  if (isCurrentOwner(owner)) await collapseRow(container.querySelector(`#subscriptions-list .swipe-row[data-swipe-id="${id}"]`));
  state.subscriptions = state.subscriptions.filter((entry) => entry.id !== id);
  if (await reload(undefined, { motion: true, owner })) refocusAfterRender();
  scheduleUndoableDelete({
    commit: async ({ keepalive } = {}) => {
      try {
        await api.delete(`/budget/subscriptions/${id}`, { keepalive });
      } catch (err) {
        // SCHON GELOESCHT IST EIN ERFOLG (#1909): ein anderes Haushaltsmitglied
        // war schneller.
        if (!isAlreadyDeleted(err, 'subscriptions_subscription_not_found')) throw err;
      }
      pendingDeletes.delete(id);
    },
    restore: async (err) => {
      pendingDeletes.delete(id);
      if (err) await reportError(err, { owner });
      if (isCurrentOwner(owner) && await reload(undefined, { motion: true, owner })) refocusAfterRender();
    },
    message: t('common.deletedNamed', { name: subscription.name }),
  });
}

async function openSettingsModal() {
  if (readOnly()) return;
  const content = `
    <form id="subscriptions-settings-form" novalidate>
      <div class="form-group">
        <label class="form-label" for="subscriptions-budget">${t('subscriptions.monthlyBudgetLabel')}</label>
        <input class="form-input" id="subscriptions-budget"${amountInputAttrs(state.settings.base_currency, state.settings.monthly_budget)}>
      </div>
      ${comboboxMarkup({
        id: 'subscriptions-base-currency',
        label: t('subscriptions.baseCurrencyLabel'),
        items: currencyItems(),
        value: state.settings.base_currency,
        placeholder: t('subscriptions.currencySearchPlaceholder'),
      })}
      <div class="form-group">
        <small>${t('subscriptions.fixerHint')}</small>
      </div>
      <div class="modal-panel__footer subscriptions-modal-footer">
        <button class="btn btn--secondary" type="button" id="subscriptions-settings-cancel">${t('common.cancel')}</button>
        <button class="btn btn--primary" type="submit">${t('common.save')}</button>
      </div>
    </form>
  `;
  openModal({
    title: t('subscriptions.settingsTitle'),
    content,
    size: 'sm',
    onSave(panel) {
      wireCombobox(panel, 'subscriptions-base-currency');
      panel.querySelector('#subscriptions-base-currency').addEventListener('change', (event) => {
        setAmountCurrency(panel.querySelector('#subscriptions-budget'), event.target.value);
      });
      panel.querySelector('#subscriptions-settings-cancel').addEventListener('click', closeModal);
      panel.querySelector('#subscriptions-settings-form').addEventListener('submit', async (event) => {
        event.preventDefault();
        if (readOnly()) return;
        // KEINE BROWSER-BLASEN (Critique R21): `novalidate`, die Regeln des Markups melden sich am Feld (constraintErrors, components/modal.js).
        if (reportFieldErrors(constraintErrors(event.currentTarget))) return;
        const baseCurrency = panel.querySelector('#subscriptions-base-currency').value;
        if (!baseCurrency) {
          reportFieldError(panel.querySelector('#subscriptions-base-currency-search'), t('subscriptions.currencyRequired'));
          return;
        }
        // Der Betrag als TEXT (D1); ein Bestandsbudget neben dem Raster bleibt
        // unangetastet speicherbar. Leer heisst kein Budget (0).
        const budgetProblem = amountFieldError(panel.querySelector('#subscriptions-budget'), baseCurrency, {
          sign: 'nonNegative',
          original: state.settings.monthly_budget ?? null,
          originalCurrency: state.settings.base_currency ?? null,
        });
        if (budgetProblem) {
          reportFieldError(...budgetProblem);
          return;
        }
        const owner = pageOwner();
        const dialog = captureModalContext();
        try {
          await api.put('/budget/subscriptions/settings', {
            monthly_budget: parseAmountInput(panel.querySelector('#subscriptions-budget').value) ?? 0,
            base_currency: baseCurrency,
          });
          await closeModal({ force: true, context: dialog });
          if (await reloadAfterSave(() => reload({ refreshRates: true }, { owner }))) refocusAfterRender();
          window.yuvomi?.showToast(t('subscriptions.settingsSaved'), 'success');
        } catch (err) {
          reportError(err, { owner });
        }
      });
    },
  });
}

function metadataRows(items, kind) {
  const isCat = kind === 'categories';
  const editLabel = isCat ? t('subscriptions.editCategory') : t('subscriptions.editPaymentMethod');
  return items.map((item, index) => {
    // Die Zeilenaktionen nennen, WORAN sie wirken: vier Knoepfe je Zeile, die
    // alle nur „Nach oben" oder „Kategorie loeschen" hiessen, waren fuer einen
    // Screenreader in jeder Zeile dieselben (Komponenten-Kanon, DESIGN.md).
    const name = isCat ? categoryLabel(item) : paymentMethodLabel(item);
    const named = (catKey, methodKey) => t(isCat ? catKey : methodKey, { name });
    // D10 ZEILEN-ENDZONE (#2152): [Mehr-Knopf][Griff]. Bis dahin standen hier
    // vier Icons nebeneinander - Auf, Ab, Stift und ein dauerhaft roter
    // Papierkorb - und schoben den Namen mobil in eine zweite Zeile. Der Name
    // oeffnet die Bearbeitung, das Menue fuehrt Bearbeiten, die zwei Schritte
    // fuer Schalter und Screenreader ohne Pfeiltasten und das Loeschen; der
    // Griff zieht und nimmt am Fokus die Pfeiltasten.
    const editLabelNamed = named('subscriptions.editCategoryNamed', 'subscriptions.editPaymentMethodNamed');
    const sortable = items.length > 1;
    const handleLabel = `${t('shopping.reorderHandle', { name })}, ${t('shopping.reorderPosition', { index: index + 1, total: items.length })}`;
    return `
    <li data-id="${item.id}" data-kind="${kind}">
      <div class="subscriptions-metadata-row__view">
        ${isCat ? `<i style="background:${esc(item.color)}"></i>` : '<i data-lucide="credit-card" aria-hidden="true"></i>'}
        <button type="button" class="subscriptions-metadata-row__name" data-act="edit" title="${esc(editLabelNamed)}">${esc(name)}</button>
        <div class="row-actions subscriptions-metadata-row__actions">
          ${rowMenuHtml({
    id: `subscriptions-meta-menu-${kind}-${item.id}`,
    label: t('common.moreActionsNamed', { name }),
    items: [
      { action: 'meta-edit', icon: 'pencil', label: editLabelNamed, attrs: { 'data-act': 'edit' } },
      sortable && { action: 'meta-up', icon: 'chevron-up', label: t('subscriptions.moveUpNamed', { name }), disabled: index === 0, attrs: { 'data-move': '-1' } },
      sortable && { action: 'meta-down', icon: 'chevron-down', label: t('subscriptions.moveDownNamed', { name }), disabled: index === items.length - 1, attrs: { 'data-move': '1' } },
      { action: 'meta-delete', icon: 'trash-2', danger: true, label: named('subscriptions.deleteCategoryNamed', 'subscriptions.deletePaymentMethodNamed'), attrs: { 'data-act': 'delete' } },
    ],
  })}
          ${sortable ? `<button type="button" class="row-action list-row__drag subscriptions-metadata-row__handle" data-meta-handle
                  aria-label="${esc(handleLabel)}"
                  title="${esc(t('shopping.reorderHandleHint'))}">
            <i data-lucide="grip-vertical" class="icon-md" aria-hidden="true"></i>
          </button>` : ''}
        </div>
      </div>
      <div class="subscriptions-metadata-row__edit" hidden>
        <input class="form-input subscriptions-metadata-edit-name" value="${esc(isCat ? categoryLabel(item) : paymentMethodLabel(item))}" data-original-name="${esc(item.name ?? '')}" maxlength="100" aria-label="${editLabel}">
        ${isCat ? colorPickerHtml({ value: item.color, label: t('subscriptions.brandColorLabel'), options: subscriptionColorOptions(), inputClass: 'subscriptions-metadata-edit-color', className: 'subscriptions-metadata-row__color' }) : ''}
        <div class="subscriptions-metadata-row__actions">
          <button class="btn btn--icon" data-act="save" aria-label="${t('common.save')}">
            <i data-lucide="check" aria-hidden="true"></i>
          </button>
          <button class="btn btn--icon" data-act="cancel" aria-label="${t('common.cancel')}">
            <i data-lucide="x" aria-hidden="true"></i>
          </button>
        </div>
      </div>
    </li>
  `;
  }).join('');
}

/**
 * Eine Schreibhandlung im Verwalten-Dialog: nach dem Erfolg schliessen, neu
 * laden und den Dialog mit dem frischen Stand neu aufbauen. Scheitert sie,
 * sagt der Toast den Satz der App; "gibt es nicht mehr" baut den Dialog
 * ebenfalls frisch auf, eine vergebene Bezeichnung laesst ihn mit der Eingabe
 * stehen.
 *
 * @returns {Promise<boolean>} ob der Server die Handlung angenommen hat
 */
async function saveMetadata(write, goneId = null) {
  const dialog = captureModalContext();
  const owner = pageOwner();
  try {
    await write();
  } catch (err) {
    reportError(err, { owner, dialog, goneId, reopen: openMetadataModal });
    return false;
  }
  // Nur DIESEN Dialog schliessen, und nur ihn neu aufbauen: hat der Nutzer
  // inzwischen einen anderen geoeffnet, schloesse openMetadataModal() ihn
  // ebenso wie ein closeModal() ohne Kontext (#1997).
  const own = isOwnModalOpen(dialog);
  await closeModal({ force: true, context: dialog });
  // Auch das Laden danach braucht Zeit: was der Nutzer IN DIESER Zeit oeffnet,
  // gehoert ebenso ihm. Der Kontext von jetzt (eigener Dialog zu) muss nach dem
  // Laden noch gelten - sonst hat inzwischen ein anderer Dialog den Slot.
  const afterClose = captureModalContext();
  if (await reload(undefined, { owner }) && own && isModalContextCurrent(afterClose)) {
    refocusAfterRender();
    openMetadataModal();
  }
  return true;
}

/**
 * Wohin der Fokus geht, wenn der Verwalten-Dialog nach einer Handlung neu
 * aufgebaut ist (#2152): jede Schreibhandlung schliesst ihn und baut ihn mit
 * dem frischen Stand neu (saveMetadata), und ohne Ziel fiele der Fokus auf den
 * Anfang - wer per Pfeiltaste am Griff schiebt, verloere nach einem Schritt
 * die Zeile. `{ kind, id, target: 'handle' | 'more', index }`: die Zeile
 * selbst, sonst die, die jetzt an `index` steht.
 */
let metaFocus = null;

/** Die Sortable-Instanzen des Verwalten-Dialogs: frei beim Neuaufbau und beim Schliessen. */
const metaSortables = sortableSet();

function restoreMetaFocus(panel) {
  const intent = metaFocus;
  metaFocus = null;
  if (!intent) return;
  const list = panel.querySelector(intent.kind === 'categories' ? '#subscription-category-list' : '#subscription-method-list');
  const rows = [...(list?.querySelectorAll(':scope > li') ?? [])];
  const row = rows.find((li) => Number(li.dataset.id) === intent.id)
    ?? rows[Math.min(intent.index ?? 0, rows.length - 1)];
  if (!row) return;
  const handle = intent.target === 'handle' ? row.querySelector('[data-meta-handle]') : null;
  (handle ?? row.querySelector('.row-action--more') ?? row.querySelector('[data-act="edit"]'))?.focus();
}

/**
 * Die Zuege, die gerade speichern, JE LISTE (`categories` / `payment_methods`
 * -> `{ ids }`). Je Liste, nicht fuer den Dialog (Codex an #2177): ein
 * geteilter Merker nahm einen Zug der Zahlungsarten mit der Folge der
 * Kategorien zurueck.
 */
const metaOrderRuns = new Map();

const metaKeyOf = (list) => (list.id.includes('category') ? 'categories' : 'payment_methods');

/** Neue Reihenfolge einer Liste speichern - Pfeiltaste, Menue und Drag-Ende teilen diesen Weg. */
async function persistMetaOrder(list, ids) {
  // Der Riegel am Schreibweg selbst: Pfeiltaste, Menue und Drag-Ende kommen
  // alle hier vorbei (Nur-lesen-Regel, test:budget-readonly-ui).
  if (readOnly()) return null;
  const key = metaKeyOf(list);
  // EIN ZUG ZUR ZEIT JE LISTE (Codex an #2177): waehrend einer speichert,
  // entfaellt der naechste derselben Liste. Ein gezogener Zug wird
  // zurueckgenommen - die Liste zeigt dann wieder, was gerade gespeichert wird.
  const running = metaOrderRuns.get(key);
  if (running) {
    restoreOrder(list, running.ids, (li) => li.dataset.id);
    return null;
  }
  metaOrderRuns.set(key, { ids });
  let saved;
  try {
    saved = await saveMetadata(() => api.put('/budget/subscriptions/meta/order', { [key]: ids }));
  } finally {
    metaOrderRuns.delete(key);
  }
  if (!saved) {
    // GESCHEITERT, OHNE DASS DER DIALOG NEU AUFGEHT (Codex an #2177): das
    // Ziehen hat die Zeile schon umgehaengt. Zurueck auf den gespeicherten
    // Stand, sonst stuenden Reihenfolge, Griff-Positionen und gesperrtes
    // Auf/Ab falsch da. Der Fokuswunsch des Schritts verfaellt mit ihm.
    restoreOrder(list, state.meta[key].map((row) => row.id), (li) => li.dataset.id);
    metaFocus = null;
  }
  return saved;
}

function moveMetaRow(row, delta, target) {
  const list = row?.closest('ul');
  if (!list) return null;
  const rows = [...list.querySelectorAll(':scope > li')];
  const index = rows.indexOf(row);
  const next = index + delta;
  if (index < 0 || next < 0 || next >= rows.length) return null;
  if (metaOrderRuns.has(metaKeyOf(list))) return null;
  [rows[index], rows[next]] = [rows[next], rows[index]];
  metaFocus = { kind: row.dataset.kind, id: Number(row.dataset.id), target, index: next };
  return persistMetaOrder(list, rows.map((li) => Number(li.dataset.id)));
}

/**
 * DIE FARBREIHE DER ABOS (Critique R24 E6): vorn die Standardfarbe des Moduls
 * (`#0F766E`, auch der Rueckfall jeder Zeile ohne Markenfarbe), dahinter die
 * Familientoene und "Eigene" fuer die echte Markenfarbe.
 */
function subscriptionColorOptions() {
  return [{ value: SUBSCRIPTION_COLOR_DEFAULT, label: t('colorPicker.standard') }, ...familyColorOptions()];
}

function openMetadataModal() {
  if (readOnly()) return;
  const content = `
    <div class="subscriptions-metadata">
      <section>
        <h3>${t('subscriptions.categoriesTitle')}</h3>
        <ul id="subscription-category-list">${metadataRows(state.meta.categories, 'categories')}</ul>
        <div class="subscriptions-metadata-add">
          <input class="form-input" id="subscription-new-category" placeholder="${t('subscriptions.newCategoryPlaceholder')}">
          <button class="btn btn--primary" id="subscription-add-category">${t('common.add')}</button>
          ${colorPickerHtml({ id: 'subscription-new-category-color', value: SUBSCRIPTION_COLOR_DEFAULT, label: t('subscriptions.brandColorLabel'), options: subscriptionColorOptions(), className: 'subscriptions-metadata-add__color' })}
        </div>
      </section>
      <section>
        <h3>${t('subscriptions.paymentMethodsTitle')}</h3>
        <ul id="subscription-method-list">${metadataRows(state.meta.payment_methods, 'methods')}</ul>
        <div class="subscriptions-metadata-add">
          <input class="form-input" id="subscription-new-method" placeholder="${t('subscriptions.newPaymentMethodPlaceholder')}">
          <button class="btn btn--primary" id="subscription-add-method">${t('common.add')}</button>
        </div>
      </section>
      <div class="modal-panel__footer subscriptions-modal-footer">
        <button class="btn btn--primary" id="subscriptions-metadata-close">${t('common.close')}</button>
      </div>
    </div>
  `;
  openModal({
    title: t('subscriptions.manageMetadata'),
    content,
    size: 'xl',
    onClose: () => metaSortables.clear(),
    onSave(panel) {
      wireColorPicker(panel);
      panel.querySelector('#subscriptions-metadata-close').addEventListener('click', closeModal);
      panel.querySelector('#subscription-add-category').addEventListener('click', async () => {
        if (readOnly()) return;
        const name = panel.querySelector('#subscription-new-category').value.trim();
        if (!name) return;
        // Bis #1909 ohne catch: eine vergebene Kategorie lief als unbehandelte
        // Ablehnung bis in den Router und zeigte dort den Text des Servers.
        await saveMetadata(() => api.post('/budget/subscriptions/categories', {
          name,
          color: panel.querySelector('#subscription-new-category-color').value,
        }));
      });
      panel.querySelector('#subscription-add-method').addEventListener('click', async () => {
        if (readOnly()) return;
        const name = panel.querySelector('#subscription-new-method').value.trim();
        if (!name) return;
        await saveMetadata(() => api.post('/budget/subscriptions/payment-methods', { name }));
      });
      // Die Mehr-Menues der Zeilen (#2152): Lage, Schliessen nach der Wahl, Pfeiltasten.
      installPopoverMenus(panel);
      // Auf/Ab im Menue: am Listenrand ist der Eintrag gesperrt (`disabled`).
      panel.querySelectorAll('[data-move]').forEach((button) => {
        button.addEventListener('click', () => {
          if (readOnly() || button.disabled) return;
          moveMetaRow(button.closest('li'), Number(button.dataset.move), 'more');
        });
      });
      // Der Griff: Pfeiltasten bei Fokus (wie im Einkauf) und Ziehen.
      panel.querySelectorAll('[data-meta-handle]').forEach((handle) => {
        handle.addEventListener('keydown', (event) => {
          if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
          event.preventDefault();
          if (readOnly()) return;
          moveMetaRow(handle.closest('li'), event.key === 'ArrowUp' ? -1 : 1, 'handle');
        });
      });
      // Jeder Aufbau gibt die Instanzen des vorigen frei (Codex an #2177).
      metaSortables.clear();
      for (const list of panel.querySelectorAll('#subscription-category-list, #subscription-method-list')) {
        if (list.children.length < 2) continue;
        metaSortables.add(list, {
          handle: '[data-meta-handle]',
          onEnd: (evt) => {
            if (readOnly() || evt.oldIndex === evt.newIndex) return;
            persistMetaOrder(list, [...list.querySelectorAll(':scope > li')].map((li) => Number(li.dataset.id)));
          },
        }).catch(() => { /* ohne SortableJS bleiben Pfeiltasten und Menue */ });
      }
      restoreMetaFocus(panel);

      // Inline-Bearbeitung: die vorgerenderte Edit-Zeile ein-/ausblenden.
      panel.querySelectorAll('[data-act="edit"]').forEach((button) => {
        button.addEventListener('click', () => {
          const li = button.closest('li');
          li.querySelector('.subscriptions-metadata-row__view').hidden = true;
          const editRow = li.querySelector('.subscriptions-metadata-row__edit');
          editRow.hidden = false;
          editRow.querySelector('.subscriptions-metadata-edit-name').focus();
        });
      });
      panel.querySelectorAll('[data-act="cancel"]').forEach((button) => {
        button.addEventListener('click', () => {
          const li = button.closest('li');
          const editRow = li.querySelector('.subscriptions-metadata-row__edit');
          const nameInput = editRow.querySelector('.subscriptions-metadata-edit-name');
          nameInput.value = nameInput.defaultValue;
          const colorInput = editRow.querySelector('.subscriptions-metadata-edit-color');
          if (colorInput) setColorPickerValue(colorInput, colorInput.defaultValue);
          editRow.hidden = true;
          li.querySelector('.subscriptions-metadata-row__view').hidden = false;
          // Fokus zurück, statt ins Leere (der Cancel-Button wird gerade
          // versteckt): an den Mehr-Knopf der Zeile, aus dem "Bearbeiten" kam,
          // sonst an den Namen, der es ebenso oeffnet.
          (li.querySelector('.row-action--more') ?? li.querySelector('[data-act="edit"]')).focus();
        });
      });
      // Tastatur im Inline-Edit: Enter speichert, Escape bricht ab. stopPropagation
      // hält den globalen Modal-Handler (modal.js) davon ab, den ersten .btn--primary
      // im Panel zu klicken bzw. das ganze Modal via Escape zu schließen.
      panel.querySelectorAll('.subscriptions-metadata-row__edit input').forEach((input) => {
        input.addEventListener('keydown', (event) => {
          if (isImeComposing(event)) return;
          if (event.key !== 'Enter' && event.key !== 'Escape') return;
          event.preventDefault();
          event.stopPropagation();
          const act = event.key === 'Enter' ? 'save' : 'cancel';
          input.closest('li').querySelector(`[data-act="${act}"]`).click();
        });
      });
      panel.querySelectorAll('[data-act="save"]').forEach((button) => {
        button.addEventListener('click', async () => {
          if (readOnly()) return;
          const li = button.closest('li');
          const id = Number(li.dataset.id);
          const editRow = li.querySelector('.subscriptions-metadata-row__edit');
          const nameInput = editRow.querySelector('.subscriptions-metadata-edit-name');
          const typed = nameInput.value.trim();
          if (!typed) { nameInput.focus(); return; }
          // Das Feld zeigt bei Default-Kategorien den lokalisierten Namen ("Bildung").
          // Bleibt er unverändert (z. B. nur Farbe geändert), den gespeicherten Kanon-
          // Namen ("Education") behalten, damit die Lokalisierung nicht verloren geht.
          const name = nameInput.value === nameInput.defaultValue
            ? (nameInput.dataset.originalName ?? typed)
            : typed;
          const colorInput = editRow.querySelector('.subscriptions-metadata-edit-color');
          const isCat = li.dataset.kind === 'categories';
          metaFocus = { kind: li.dataset.kind, id, target: 'more', index: [...li.parentElement.children].indexOf(li) };
          const saved = await saveMetadata(() => (isCat
            ? api.put(`/budget/subscriptions/categories/${id}`, { name, color: colorInput.value })
            : api.put(`/budget/subscriptions/payment-methods/${id}`, { name })), id);
          if (saved) window.yuvomi?.showToast(t('subscriptions.metaSavedToast'), 'success');
        });
      });
      panel.querySelectorAll('[data-act="delete"]').forEach((button) => {
        button.addEventListener('click', async () => {
          if (readOnly()) return;
          const li = button.closest('li');
          const id = Number(li.dataset.id);
          const isCat = li.dataset.kind === 'categories';
          const item = state.meta[isCat ? 'categories' : 'payment_methods'].find((row) => row.id === id);
          const inUse = item?.usage_count || 0;
          const name = item ? (isCat ? categoryLabel(item) : paymentMethodLabel(item)) : '';
          // confirmOverModal parkt das Verwalten-Modal, statt es zu ersetzen:
          // „Abbrechen" gibt es mitsamt Scrollposition und Fokus zurück. Nur
          // nach echtem Löschen wird es neu aufgebaut - die Liste hat sich
          // geändert.
          // Der Folgentext haengt nicht daran, ob gerade ein Abo zugeordnet ist:
          // bei einer Kategorie faellt die verknuepfte Budget-Unterkategorie in
          // jedem Fall mit (routes/subscriptions.js). Frueher stand `detail` bei
          // usage_count 0 auf null - dann nannte der Dialog gar keine Folge.
          const warnung = inUse ? `${t('subscriptions.metaInUseWarning', { count: inUse })} ` : '';
          const confirmed = await confirmOverModal(
            t(isCat ? 'subscriptions.deleteCategoryConfirm' : 'subscriptions.deletePaymentMethodConfirm', { name }),
            {
              danger: true,
              detail: isCat
                ? `${warnung}${t('subscriptions.deleteCategoryConfirmDetail')}`
                : `${warnung}${t('subscriptions.deletePaymentMethodConfirmDetail')}`,
            },
          );
          if (!confirmed) return;
          // Nach dem Neuaufbau an den Mehr-Knopf der Zeile, die jetzt an
          // ihrem Platz steht (#2152).
          metaFocus = { kind: li.dataset.kind, id, target: 'more', index: [...li.parentElement.children].indexOf(li) };
          const owner = pageOwner();
          // Die Verwaltung ist jetzt zu. Was der Nutzer waehrend des Loeschens
          // und Ladens oeffnet, gehoert ihm: openMetadataModal() schloesse es
          // ebenso wie ein closeModal() ohne Kontext (#1997).
          const afterConfirm = captureOpenContext();
          try {
            await api.delete(`/budget/subscriptions/${isCat ? 'categories' : 'payment-methods'}/${id}`);
          } catch (err) {
            // Schon geloescht ist ein Erfolg (#1909): Kategorien und
            // Zahlungsarten haben keine Sichtbarkeit, die 404 heisst nur das.
            if (!isAlreadyDeleted(err, isCat ? 'subscriptions_category_not_found' : 'subscriptions_payment_method_not_found')) {
              window.yuvomi?.showToast(errorText(err), 'danger');
              if (isCurrentOwner(owner) && isModalContextCurrent(afterConfirm)) openMetadataModal();
              return;
            }
          }
          if (!isCurrentOwner(owner)) return;
          // Ein Filter auf die geloeschte geht vor dem Laden auf "alle".
          resetGoneFilter(isCat ? 'subscriptions_category_not_found' : 'subscriptions_payment_method_not_found', id);
          if (!await reload(undefined, { owner })) return;
          window.yuvomi?.showToast(t('subscriptions.metaDeletedToast'), 'success');
          if (!isModalContextCurrent(afterConfirm)) return;
          refocusAfterRender();
          openMetadataModal();
        });
      });
    },
  });
}

/**
 * Messflaeche fuer die Nur-lesen-Regel (#1265 P7): Karten- und Leerzustands-
 * Renderer sind reine Funktionen ueber `state`.
 */
export const __test = {
  readOnly, READ_SAFE_ACTIONS, renderCard, renderEmpty, renderSummary, renderOverBudgetNote, state, toolsMenuHtml, activeFilters,
  renderBreakdown, renderAreaChart,
  subscriptionReadSections, openSubscriptionModal, saveSubscription,
  // R24 E1: der Tipp auf ein Abo oeffnet das Leseblatt (test-budget-readonly-ui.js).
  openSubscriptionReadView,
  // #1909: die Fehlerwege der Seite (test:subscriptions-errors).
  reload, renewSubscription, deleteSubscription, openSettingsModal, openMetadataModal, openLogoPickerModal,
  // #2152: die Zeilen des Verwalten-Dialogs (test:manager-endzone).
  metadataRows, persistMetaOrder,
  dueLabel,
  // Eine neue Instanz der Seite, wie ein render() sie anlegt.
  setContainerForTest: (target) => { container = target; pageGeneration += 1; },
};
