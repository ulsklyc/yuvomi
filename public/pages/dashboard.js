/**
 * Modul: Dashboard
 * Zweck: Startseite mit Begrüßung, Terminen, Aufgaben, Essen, Notizen und FAB
 * Abhängigkeiten: /api.js
 */

import { api } from '/api.js';
import { t, formatDate, formatTime, getLocale } from '/i18n.js';
import { getReadableTextColor, AVATAR_FALLBACK_COLOR } from '/utils/color.js';
import { esc, fmtLocation, renderMarkdownLight } from '/utils/html.js';
import { toLocalDateKey } from '/utils/date.js';
import { predictCycle, PHASE } from '/utils/health-cycle.js';
import { openModal, closeModal, confirmModal } from '/components/modal.js';
import { renderAvatarStack } from '/components/user-multi-select.js';

// Hält den AbortController des aktuellen FAB-Listeners - wird bei jedem render() erneuert.
let _fabController = null;


// ── Onboarding ──────────────────────────────────────────────────────────────

const ONBOARDING_KEY = 'yuvomi-onboarded';
const APP_NAME_STORAGE_KEY = 'yuvomi-app-name';
const CUSTOMIZE_HINT_KEY = 'yuvomi-dash-customize-hint';

function eventOccurrenceDateKey(event) {
  const value = String(event?.start_datetime || '');
  if (!value) return '';
  if (value.length <= 10) return value.slice(0, 10);

  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value.slice(0, 10) : toLocalDateKey(date);
}

function calendarEventRoute(event) {
  if (!event?.id) return '/calendar';
  const params = new URLSearchParams({ open: String(event.id) });
  const occurrenceDate = eventOccurrenceDateKey(event);
  if (/^\d{4}-\d{2}-\d{2}$/.test(occurrenceDate)) params.set('date', occurrenceDate);
  return `/calendar?${params.toString()}`;
}

function getAppName() {
  return localStorage.getItem(APP_NAME_STORAGE_KEY) || 'Yuvomi';
}

function getOnboardingSteps() {
  const appName = getAppName();
  return [
    { icon: 'home',         title: t('onboarding.step1Title', { name: appName }), body: t('onboarding.step1Body') },
    { icon: 'navigation',   title: t('onboarding.step2Title'), body: t('onboarding.step2Body') },
    { icon: 'plus-circle',  title: t('onboarding.step3Title'), body: t('onboarding.step3Body') },
  ];
}

function showOnboarding(appContainer, onDone) {
  const steps = getOnboardingSteps();
  let current = 0;

  // Fokus vor dem Dialog merken, um ihn beim Schließen zurückzugeben.
  const previouslyFocused = document.activeElement;

  const overlay = document.createElement('div');
  overlay.className = 'onboarding-overlay';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');

  const onKeydown = (event) => {
    if (event.key === 'Escape') { finish(); return; }
    if (event.key !== 'Tab') return;
    // Fokus-Trap (WCAG 2.4.3/2.1.2): der Erststart-Dialog darf den Fokus nicht
    // auf die verdeckte Seite dahinter entlassen. Fokussierbare Elemente je
    // Tab-Druck neu ermitteln, da renderStep() den Karteninhalt austauscht.
    const focusables = overlay.querySelectorAll(
      'button, [href], input, [tabindex]:not([tabindex="-1"])',
    );
    if (!focusables.length) return;
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };
  document.addEventListener('keydown', onKeydown);

  function renderStep() {
    const step = steps[current];
    const isLast = current === steps.length - 1;
    overlay.replaceChildren();

    const card = document.createElement('div');
    card.className = 'onboarding-card';

    const icon = document.createElement('i');
    icon.dataset.lucide = step.icon;
    icon.className = 'onboarding-icon';
    icon.setAttribute('aria-hidden', 'true');

    const title = document.createElement('h2');
    title.className = 'onboarding-title';
    title.textContent = step.title;

    const body = document.createElement('p');
    body.className = 'onboarding-body';
    body.textContent = step.body;

    const dots = document.createElement('div');
    dots.className = 'onboarding-dots';
    steps.forEach((_, i) => {
      const dot = document.createElement('span');
      dot.className = `onboarding-dot${i === current ? ' onboarding-dot--active' : ''}`;
      dots.appendChild(dot);
    });

    const actions = document.createElement('div');
    actions.className = 'onboarding-actions';

    const skipBtn = document.createElement('button');
    skipBtn.className = 'btn btn--ghost';
    skipBtn.textContent = t('onboarding.skip');
    skipBtn.addEventListener('click', finish);

    const nextBtn = document.createElement('button');
    nextBtn.className = 'btn btn--primary';
    nextBtn.textContent = isLast ? t('onboarding.done') : t('onboarding.next');
    nextBtn.addEventListener('click', () => {
      if (isLast) { finish(); return; }
      current++;
      renderStep();
      if (window.lucide) window.lucide.createIcons({ el: overlay });
      nextBtn.focus();
    });

    if (!isLast) actions.appendChild(skipBtn);
    actions.appendChild(nextBtn);
    card.appendChild(icon);
    card.appendChild(title);
    card.appendChild(body);
    card.appendChild(dots);
    card.appendChild(actions);
    overlay.appendChild(card);

    if (window.lucide) window.lucide.createIcons({ el: overlay });
    setTimeout(() => nextBtn.focus(), 50);
  }

  let finished = false;
  function finish() {
    if (finished) return;
    finished = true;
    document.removeEventListener('keydown', onKeydown);
    localStorage.setItem(ONBOARDING_KEY, '1');
    // Fokus dorthin zurückgeben, wo er vor dem Dialog lag (sonst neutral auf
    // den Body), damit Tastatur-/SR-Nutzer nicht im entfernten Overlay hängen.
    const restoreTarget = (previouslyFocused && document.contains(previouslyFocused))
      ? previouslyFocused
      : document.body;
    overlay.classList.add('onboarding-overlay--out');
    overlay.addEventListener('animationend', () => overlay.remove(), { once: true });
    // Fallback falls animationend nicht feuert (prefers-reduced-motion):
    setTimeout(() => overlay.remove(), 300);
    restoreTarget?.focus?.();
    onDone?.();
  }

  renderStep();
  appContainer.appendChild(overlay);
}

// Einmaliger, zurückhaltender Hinweis auf den „Anpassen"-Einstieg: Da vier Widgets
// standardmäßig hinter dem Cockpit ausgeblendet sind, macht ein sanfter Puls beim
// Erststart sichtbar, wo sie sich wieder einblenden lassen. Danach nie wieder.
function maybeHintCustomize(container) {
  if (localStorage.getItem(CUSTOMIZE_HINT_KEY)) return;
  const btn = container.querySelector('#dashboard-customize-btn');
  if (!btn) return;
  const clear = () => {
    btn.classList.remove('dashboard-icon-btn--hint');
    localStorage.setItem(CUSTOMIZE_HINT_KEY, '1');
  };
  btn.classList.add('dashboard-icon-btn--hint');
  btn.addEventListener('click', clear, { once: true });
  setTimeout(clear, 6000);
}

// --------------------------------------------------------
// Widget-Definitionen (Reihenfolge = Standard-Layout)
// --------------------------------------------------------

// Reihenfolge = Standard-Layout. Die primären Inhalte (tasks, calendar) führen,
// damit sie beim Wieder-Einblenden oben stehen; das einzige passive Widget
// (weather) steht bewusst am Ende, statt die sichtbare Grid-Spitze zu belegen.
const WIDGET_IDS = ['tasks', 'calendar', 'meals', 'shopping', 'birthdays', 'budget', 'rewards', 'health', 'cycle', 'housekeeping', 'family', 'notes', 'weather'];

// Sechs benannte Formen decken die üblichen Dashboard-Bedürfnisse ab: kompakte
// Statuskacheln, hohe Listen, Standardkarten sowie breite Übersichten. Die volle
// 1-4 x 1-4-Matrix bleibt als gespeicherter/validierter Wert erhalten, damit
// bestehende Layouts nicht beim nächsten Rendern zusammengezogen werden.
const WIDGET_SIZE_PRESETS = [
  { value: '1x1', labelKey: 'dashboard.widgetSizeTiny'     },
  { value: '2x1', labelKey: 'dashboard.widgetSizeNarrow'   },
  { value: '1x2', labelKey: 'dashboard.widgetSizeTall'     },
  { value: '2x2', labelKey: 'dashboard.widgetSizeStandard' },
  { value: '3x2', labelKey: 'dashboard.widgetSizeLarge'    },
  { value: '4x2', labelKey: 'dashboard.widgetSizeFull'     },
];

// Alle bekannten Größen inkl. API-validierter Legacy-/Direktwerte.
const WIDGET_SIZE_OPTIONS = [
  '1x1', '1x2', '1x3', '1x4',
  '2x1', '2x2', '2x3', '2x4',
  '3x1', '3x2', '3x3', '3x4',
  '4x1', '4x2', '4x3', '4x4',
];

// Markiert in der UI bei nicht direkt angebotenen Matrixwerten das nächstliegende
// benannte Preset, ohne den gespeicherten Wert zu verändern.
function nearestPreset(size) {
  const values = WIDGET_SIZE_PRESETS.map((p) => p.value);
  if (values.includes(size)) return size;
  const [cols, rows] = String(size).split('x').map(Number);
  if (!Number.isFinite(cols) || !Number.isFinite(rows)) return '1x1';
  if (cols >= 4) return '4x2';
  if (cols >= 3) return '3x2';
  if (cols >= 2) return rows >= 2 ? '2x2' : '2x1';
  return rows >= 2 ? '1x2' : '1x1';
}

function defaultWidgetSize(id) {
  // Listen-Widgets defaulten auf schmal-hoch (1×2) statt breit-hoch (2×2): eine
  // „Heute"-Liste braucht Höhe, nicht Breite — 1×2 halbiert die Grundfläche und
  // packt sich sauber neben andere Widgets, statt als 2-spaltige Kachel eine
  // ganze Rasterzeile zu belegen (löst die Masonry-Imbalance an der Wurzel).
  // Inhaltsschwere Karten (gestapelte Blöcke) starten hoch statt 1×1, damit die
  // Zeile nicht per grid-auto ragged nachwächst (Critique P4). Budget stapelt
  // Saldo + Sparen + Einnahme/Ausgabe + Top-Ausgabe → 1×2.
  if (['tasks', 'calendar', 'rewards', 'budget'].includes(id)) return '1x2';
  if (['weather', 'shopping', 'health', 'cycle', 'meals'].includes(id)) return '2x1';
  if (id === 'notes') return '2x1';
  return '1x1';
}

// Das „Heute"-Cockpit fasst diese vier Domänen bereits als Kurzüberblick zusammen.
// Ihre Widgets starten deshalb ausgeblendet: kein Echo, keine Erststart-Überladung.
// Über „Anpassen" jederzeit wieder einblendbar; Bestandskonfigurationen bleiben unberührt.
const COCKPIT_COVERED_WIDGETS = new Set(['tasks', 'calendar', 'shopping', 'meals']);

// Standardmäßig ausgeblendet: die vier vom Cockpit abgedeckten Domänen (kein Echo)
// plus die drei neueren Module (rewards, health, housekeeping). Letztere sind
// spezialisiert und nicht in jedem Haushalt aktiv — sie erscheinen als Opt-in im
// „Anpassen"-Panel, statt frische Dashboards mit leeren Kacheln zu überladen
// (PRODUCT.md: „Power wird auf Abruf enthüllt, nicht in einem Raster ausgebreitet").
const DEFAULT_HIDDEN_WIDGETS = new Set([...COCKPIT_COVERED_WIDGETS, 'rewards', 'health', 'cycle', 'housekeeping']);

function defaultWidgetVisible(id) {
  return !DEFAULT_HIDDEN_WIDGETS.has(id);
}

const DEFAULT_WIDGET_CONFIG = WIDGET_IDS.map((id, i) => ({ id, visible: defaultWidgetVisible(id), order: i, size: defaultWidgetSize(id) }));

// Widget → Modul-Slug für die „Modul deaktiviert?"-Prüfung. Widgets ohne Eintrag
// (family, weather) sind immer verfügbar. Modulweit, damit Grid-Filter und
// Wieder-Einblenden-Leiste dieselbe Sichtbarkeitsregel teilen.
const MODULE_FOR_WIDGET = { tasks: 'tasks', calendar: 'calendar', shopping: 'shopping', meals: 'meals', notes: 'notes', birthdays: 'birthdays', budget: 'budget', rewards: 'rewards', health: 'health', cycle: 'health', housekeeping: 'housekeeping' };

function isWidgetModuleEnabled(id) {
  const mod = MODULE_FOR_WIDGET[id];
  return !mod || !window.yuvomi?.isModuleDisabled(mod);
}

function normalizeDashboardConfig(input) {
  const valid = Array.isArray(input)
    ? input
      .filter((w) => w && typeof w === 'object' && WIDGET_IDS.includes(w.id))
      .map((w, i) => ({
        id: w.id,
        visible: w.visible !== false,
        order: Number.isFinite(Number(w.order)) ? Number(w.order) : i,
        size: WIDGET_SIZE_OPTIONS.includes(w.size) ? w.size : defaultWidgetSize(w.id),
      }))
    : [];
  const presentIds = new Set(valid.map((w) => w.id));
  for (const id of WIDGET_IDS) {
    if (!presentIds.has(id)) {
      // Neu hinzugekommene Widget-IDs (bei bestehenden, gespeicherten Layouts) erben den
      // Standard-Sichtbarkeitswert ihrer Domäne — Opt-in-Module (rewards/health/housekeeping)
      // erscheinen also nicht ungefragt, sondern bleiben im „Anpassen"-Panel angeboten.
      valid.push({ id, visible: defaultWidgetVisible(id), order: valid.length, size: defaultWidgetSize(id) });
    }
  }
  return valid
    .sort((a, b) => a.order - b.order)
    .map((w, i) => ({ ...w, order: i }));
}

// Hat der Nutzer die Widget-Reihenfolge bewusst geändert (vs. dem Autor-Default)?
// Nur dann darf das Grid auf `grid-auto-flow: row` umschalten, um die gesetzte
// Ordnung zu bewahren. Beim unveränderten Default packt `dense` die Kacheln dicht
// (kein toter Weißraum auf breitem Desktop) — die Löcher entstünden sonst nicht aus
// „Nutzerabsicht", sondern nur, weil der Default-Satz nicht sauber tesselliert (Critique P2).
function isUserOrderedConfig(cfg) {
  if (!Array.isArray(cfg)) return false;
  const defaultOrder = DEFAULT_WIDGET_CONFIG.map((w) => w.id).join(',');
  const currentOrder = [...cfg].sort((a, b) => a.order - b.order).map((w) => w.id).join(',');
  return currentOrder !== defaultOrder;
}

function sameWidgetConfig(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
  return a.every((w, i) => w.id === b[i].id && w.visible === b[i].visible
    && w.size === b[i].size && w.order === b[i].order);
}

function setHtml(element, html) {
  element.replaceChildren();
  element.insertAdjacentHTML('afterbegin', html);
}

function widgetLabel(id) {
  const map = {
    tasks:    () => t('nav.tasks'),
    calendar: () => t('nav.calendar'),
    shopping: () => t('nav.shopping'),
    meals:    () => t('nav.meals'),
    notes:    () => t('nav.notes'),
    weather:  () => t('dashboard.weather'),
    birthdays: () => t('nav.birthdays'),
    budget:   () => t('nav.budget'),
    rewards:  () => t('nav.rewards'),
    health:   () => t('nav.health'),
    cycle:    () => t('health.cycle.title'),
    housekeeping: () => t('nav.housekeeping'),
    family:   () => t('dashboard.familyMembers'),
  };
  return (map[id] ?? (() => id))();
}

function widgetIcon(id) {
  const map = { tasks: 'check-square', calendar: 'calendar', birthdays: 'cake', budget: 'wallet', rewards: 'award', health: 'heart-pulse', cycle: 'calendar-heart', housekeeping: 'paintbrush', family: 'users', shopping: 'shopping-cart', meals: 'utensils', notes: 'pin', weather: 'cloud-sun' };
  return map[id] ?? 'layout-dashboard';
}

const BUDGET_CATEGORY_LABEL_KEYS = {
  housing: 'catHousing',
  food: 'catFood',
  transport: 'catTransport',
  personal_health: 'catPersonalHealth',
  leisure: 'catLeisure',
  shopping_clothing: 'catShoppingClothing',
  education: 'catEducation',
  financial_other: 'catFinancialOther',
  subscriptions: 'catSubscriptions',
  'Erwerbseinkommen': 'catEarnedIncome',
  'Kapitalerträge': 'catInvestmentIncome',
  'Geschenke & Transfers': 'catTransferGiftIncome',
  'Sozialleistungen': 'catGovernmentBenefits',
  'Sonstiges Einkommen': 'catOtherIncome',
};

// --------------------------------------------------------
// Hilfsfunktionen
// --------------------------------------------------------

function greeting(displayName) {
  const h = new Date().getHours();
  if (h >= 5 && h < 12) return t('dashboard.greetingMorning', { name: esc(displayName) });
  if (h >= 12 && h < 18) return t('dashboard.greetingDay',    { name: esc(displayName) });
  return t('dashboard.greetingEvening', { name: esc(displayName) });
}

// Tageszeit-Fenster für den Begrüßungs-Gradienten (deckt sich mit greeting()).
// Nacht (0–4 Uhr) zählt zum Abend, damit 00:37 nicht als „Morgen" begrüßt wird.
function greetingPeriod() {
  const h = new Date().getHours();
  if (h >= 5 && h < 12) return 'morning';
  if (h >= 12 && h < 18) return 'day';
  return 'evening';
}

// Relatives Datumslabel: „Heute"/„Morgen", sonst das locale-formatierte Datum.
// Eigene Funktion, damit Aufrufer nur den Datumsteil brauchen, ohne ein
// zusammengesetztes „Datum, Zeit" per Komma zu zerschneiden (locale-fragil:
// manche Locales setzen selbst ein Komma ins Datum).
function relativeDateLabel(d) {
  const today = new Date();
  const tomorrow = new Date(today);
  tomorrow.setDate(today.getDate() + 1);
  if (d.toDateString() === today.toDateString()) return t('common.today');
  if (d.toDateString() === tomorrow.toDateString()) return t('common.tomorrow');
  return formatDate(d);
}

function formatDateTime(isoString) {
  if (!isoString) return '';
  const d = new Date(isoString);
  const dateStr = relativeDateLabel(d);
  const timeStr = formatTime(d);
  const suffix = t('calendar.timeSuffix');
  return `${dateStr}, ${timeStr}${suffix ? ' ' + suffix : ''}`.trim();
}

function formatDueDate(dateStr, timeStr) {
  if (!dateStr) return null;

  const dueDate = timeStr
    ? new Date(`${dateStr}T${timeStr}`)
    : new Date(`${dateStr}T23:59:59`);

  if (isNaN(dueDate)) return null;

  const now = new Date();
  const diffMs = dueDate - now;
  const diffH = diffMs / (1000 * 60 * 60);

  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const dueDay = new Date(dueDate.getFullYear(), dueDate.getMonth(), dueDate.getDate());
  const calDayDiff = Math.round((dueDay - today) / (1000 * 60 * 60 * 24));

  const fullLabel = timeStr
    ? `${formatDate(dueDate)}, ${formatTime(dueDate)}` // beide aus i18n.js
    : formatDate(dueDate);

  if (diffMs < 0) {
    return { text: `${t('dashboard.overdue')} – ${fullLabel}`, overdue: true };
  }

  if (calDayDiff === 1 && dueDate.getHours() >= 22 && diffH < 24) {
    return { text: `${t('dashboard.dueSoon')} – ${fullLabel}`, overdue: false, soon: true };
  }

  if (calDayDiff === 0) {
    return { text: timeStr ? `${t('dashboard.dueToday')} – ${formatTime(dueDate)}` : t('dashboard.dueToday'), overdue: false, soon: true };
  }

  if (calDayDiff === 1) {
    return { text: `${t('dashboard.dueTomorrow')} – ${formatTime(dueDate)}`, overdue: false };
  }

  return { text: fullLabel, overdue: false };
}

const PRIORITY_LABELS = () => ({
  urgent: t('tasks.priorityUrgent'),
  high:   t('tasks.priorityHigh'),
  medium: t('tasks.priorityMedium'),
  low:    t('tasks.priorityLow'),
});

const MEAL_ORDER = Object.freeze(['breakfast', 'lunch', 'dinner', 'snack']);

function normalizeVisibleMealTypes(visibleMealTypes) {
  if (!Array.isArray(visibleMealTypes)) return MEAL_ORDER;
  const filtered = MEAL_ORDER.filter((type) => visibleMealTypes.includes(type));
  return filtered.length ? filtered : MEAL_ORDER;
}

const MEAL_LABELS = () => ({
  breakfast: t('meals.typeBreakfast'),
  lunch:     t('meals.typeLunch'),
  dinner:    t('meals.typeDinner'),
  snack:     t('meals.typeSnack'),
});

const MEAL_ICONS = {
  breakfast: 'sunrise',
  lunch:     'sun',
  dinner:    'moon',
  snack:     'apple',
};

function initials(name = '') {
  return name.split(' ').map((w) => w[0]).join('').slice(0, 2).toUpperCase();
}

function budgetCategoryLabel(category) {
  const key = BUDGET_CATEGORY_LABEL_KEYS[category];
  return key ? t(`budget.${key}`) : (category || '-');
}

function formatCurrency(amount, currency = 'EUR') {
  return new Intl.NumberFormat(getLocale(), {
    style: 'currency',
    currency,
    maximumFractionDigits: Math.abs(amount) >= 1000 ? 0 : 2,
  }).format(amount || 0);
}

function formatPoints(value) {
  return new Intl.NumberFormat(getLocale()).format(Number(value) || 0);
}

function widgetHeader(icon, title, count, linkHref, linkLabel) {
  linkLabel = linkLabel ?? t('dashboard.allLink');
  const badge = count != null
    ? `<span class="widget__badge">${count}</span>`
    : '';
  return `
    <div class="widget__header">
      <span class="widget__title">
        <i data-lucide="${icon}" class="widget__title-icon" aria-hidden="true"></i>
        ${title}
        ${badge}
      </span>
      <button type="button" data-route="${linkHref}" class="widget__link">
        ${linkLabel}
      </button>
    </div>
  `;
}

// Dezente Aktivierungs-Affordance für Empty-States: verlinkt in den Modul-Flow,
// damit ein Erststart-Nutzer nicht in einer beschreibenden Sackgasse landet.
// Nutzt dasselbe [data-route]-System wie widget__link (wireLinks verkabelt es).
function emptyStateCta(route, label) {
  return `<button type="button" class="widget__empty-cta" data-route="${route}">
    <i data-lucide="plus" aria-hidden="true"></i>
    <span>${label}</span>
  </button>`;
}

function buildTodayHighlights(data) {
  const tasks = Array.isArray(data?.tasks)
    ? data.tasks
    : Array.isArray(data?.urgentTasks)
      ? data.urgentTasks
      : [];
  const events = Array.isArray(data?.events)
    ? data.events
    : Array.isArray(data?.upcomingEvents)
      ? data.upcomingEvents
      : [];
  const shoppingItems = Array.isArray(data?.shopping?.items) ? data.shopping.items : [];
  const shoppingLists = Array.isArray(data?.shoppingLists) ? data.shoppingLists : [];
  const meals = data?.meals ?? data?.todayMeals ?? null;

  const urgentTask = tasks.find((task) => task.priority === 'urgent') ?? tasks[0] ?? null;

  const today = new Date().toDateString();
  const todayEvents = events.filter((e) => {
    if (!e.start_datetime) return true;
    const d = new Date(e.start_datetime);
    return d.toDateString() === today;
  });
  const nextEvent = todayEvents[0] ?? null;

  const openShoppingCount = shoppingItems.length
    ? shoppingItems.filter((item) => !item.is_checked).length
    : shoppingLists.reduce((sum, list) => {
        if (Number.isFinite(Number(list.open_count))) return sum + Number(list.open_count);
        if (Number.isFinite(Number(list.openCount))) return sum + Number(list.openCount);
        const items = Array.isArray(list.items) ? list.items : [];
        return sum + items.filter((item) => !item.is_checked).length;
      }, 0);
  const { meal, mealType } = selectTodayMeal(meals);

  return {
    urgentTask,
    nextEvent,
    openShoppingCount,
    meal,
    mealType,
    taskCount: tasks.length,
    eventCount: todayEvents.length,
  };
}

// Pick the meal relevant to the current time of day (matches greeting thresholds:
// morning → breakfast, afternoon → lunch, evening → dinner). If the target meal
// is not planned, fall back to the next planned meal later today.
function selectTodayMeal(meals) {
  const order = ['breakfast', 'lunch', 'dinner'];
  const list = Array.isArray(meals)
    ? meals
    : meals && typeof meals === 'object'
      ? order.map((type) => (meals[type] ? { ...meals[type], meal_type: type } : null)).filter(Boolean)
      : [];

  const h = new Date().getHours();
  const targetType = h < 12 ? 'breakfast' : h < 18 ? 'lunch' : 'dinner';

  for (let i = order.indexOf(targetType); i < order.length; i++) {
    const found = list.find((m) => m.meal_type === order[i]);
    if (found) return { meal: found, mealType: order[i] };
  }
  return { meal: null, mealType: targetType };
}

// --------------------------------------------------------
// Skeleton
// --------------------------------------------------------

function skeletonWidget(lines = 3) {
  const lineHtml = Array.from({ length: lines }, (_, i) => `
    <div class="skeleton skeleton-line ${i % 2 === 0 ? 'skeleton-line--full' : 'skeleton-line--medium'}"></div>
  `).join('');
  return `
    <div class="widget-skeleton">
      <div class="skeleton skeleton-line skeleton-line--short"></div>
      ${lineHtml}
    </div>
  `;
}

// --------------------------------------------------------
// Widget-Renderer
// --------------------------------------------------------

function renderUrgentTasks(tasks) {
  if (!tasks.length) {
    return `<div class="widget widget--tasks">
      ${widgetHeader('check-square', t('nav.tasks'), 0, '/tasks')}
      <div class="widget__empty">
        <i data-lucide="check-circle" class="empty-state__icon" style="color:var(--color-success)" aria-hidden="true"></i>
        <div>${t('dashboard.allDone')}</div>
      </div>
    </div>`;
  }

  const items = tasks.map((t) => {
    const due = formatDueDate(t.due_date, t.due_time);
    return `
      <div class="task-item" data-task-id="${t.id}" data-task-title="${esc(t.title)}" role="button" tabindex="0">
        ${t.priority !== 'none' ? `<div class="task-item__priority task-item__priority--${t.priority}" aria-hidden="true"></div>` : ''}
        <span class="sr-only">${PRIORITY_LABELS()[t.priority] ?? t.priority}</span>
        <div class="task-item__content">
          <div class="task-item__title">${esc(t.title)}</div>
          ${due ? `<div class="task-item__meta ${due.overdue ? 'task-item__meta--overdue' : ''} ${due.soon ? 'task-item__meta--soon' : ''}">${due.text}</div>` : ''}
        </div>
        ${renderAvatarStack(t.assigned_users ?? [], { size: 28 })}
      </div>
    `;
  }).join('');

  return `<div class="widget widget--tasks">
    ${widgetHeader('check-square', t('nav.tasks'), tasks.length, '/tasks')}
    <div class="widget__body">${items}</div>
  </div>`;
}

function renderUpcomingEvents(events) {
  if (!events.length) {
    return `<div class="widget widget--calendar">
      ${widgetHeader('calendar', t('nav.calendar'), 0, '/calendar')}
      <div class="widget__empty">
        <i data-lucide="calendar-check" class="empty-state__icon" aria-hidden="true"></i>
        <div>${t('dashboard.noEvents')}</div>
      </div>
    </div>`;
  }

  const today = new Date().toDateString();
  const items = events.map((e) => {
    const d = new Date(e.start_datetime);
    const isToday = d.toDateString() === today;
    const _suffix = t('calendar.timeSuffix');
    const timeStr = e.all_day ? t('dashboard.allDay') : `${formatTime(d)}${_suffix ? ' ' + _suffix : ''}`.trim();
    return `
      <div class="event-item" data-route="${esc(calendarEventRoute(e))}" role="button" tabindex="0">
        <div class="event-item__bar" style="background-color:${esc(e.color || e.cal_color) || 'var(--color-accent)'}"></div>
        <div class="event-item__content">
          <div class="event-item__title">${esc(e.title)}</div>
          <div class="event-item__time">
            <span class="event-time-badge ${isToday ? 'event-time-badge--today' : ''}">${isToday ? t('common.today') : relativeDateLabel(new Date(e.start_datetime))}</span>
            ${timeStr}
            ${e.location ? ` · ${esc(fmtLocation(e.location))}` : ''}
            ${e.cal_name ? `<span class="event-item__cal">${esc(e.cal_name)}</span>` : ''}
          </div>
        </div>
        ${renderAvatarStack(e.assigned_users ?? [], { size: 28 })}
      </div>
    `;
  }).join('');

  return `<div class="widget widget--calendar">
    ${widgetHeader('calendar', t('nav.calendar'), events.length, '/calendar')}
    <div class="widget__body">${items}</div>
  </div>`;
}

function renderUpcomingBirthdays(birthdays) {
  if (!birthdays.length) {
    return `<div class="widget widget--birthdays">
      ${widgetHeader('cake', t('nav.birthdays'), 0, '/birthdays')}
      <div class="widget__empty">
        <i data-lucide="cake" class="empty-state__icon" aria-hidden="true"></i>
        <div>${t('dashboard.noBirthdays')}</div>
      </div>
    </div>`;
  }

  const items = birthdays.map((b) => {
    const daysLabel = b.days_until === 0
      ? t('common.today')
      : b.days_until === 1
        ? t('common.tomorrow')
        : t('dashboard.daysLeft', { count: b.days_until });
    return `
      <div class="birthday-widget-item" data-route="/birthdays" role="button" tabindex="0">
        <div class="birthday-widget-item__avatar">
          ${b.photo_data ? `<img src="${esc(b.photo_data)}" alt="" loading="lazy">` : `<span>${esc(initials(b.name))}</span>`}
        </div>
        <div class="birthday-widget-item__body">
          <div class="birthday-widget-item__name">${esc(b.name)}</div>
          <div class="birthday-widget-item__meta">${formatDate(b.next_birthday)} · ${daysLabel}</div>
        </div>
        <div class="birthday-widget-item__age">${esc(String(b.next_age ?? ''))}</div>
      </div>
    `;
  }).join('');

  return `<div class="widget widget--birthdays">
    ${widgetHeader('cake', t('nav.birthdays'), birthdays.length, '/birthdays')}
    <div class="widget__body">${items}</div>
  </div>`;
}

function renderTodayMeals(meals, visibleMealTypes = MEAL_ORDER) {
  const mealLabels = MEAL_LABELS();
  const safeMeals = Array.isArray(meals) ? meals : [];
  const slots = normalizeVisibleMealTypes(visibleMealTypes).map((type) => {
    const meal = safeMeals.find((m) => m.meal_type === type);
    return `
      <div class="meal-slot ${meal ? 'meal-slot--filled' : ''}" data-type="${type}" data-route="/meals" role="button" tabindex="0">
        <div class="meal-slot__header">
          <span class="meal-slot__type">${mealLabels[type]}</span>
          <i data-lucide="${MEAL_ICONS[type]}" class="meal-slot__icon" aria-hidden="true"></i>
        </div>
        <div class="meal-slot__title${meal ? '' : ' meal-slot__title--empty'}">${meal ? esc(meal.title) : '—'}</div>
      </div>
    `;
  }).join('');

  return `<div class="widget widget--meals">
    ${widgetHeader('utensils', t('dashboard.todayMeals'), null, '/meals', t('dashboard.weekLink'))}
    <div class="meals-widget">
      <div class="meal-slots">${slots}</div>
    </div>
  </div>`;
}

function renderPinnedNotes(notes) {
  if (!notes.length) {
    return `<div class="widget widget--notes">
      ${widgetHeader('pin', t('nav.notes'), 0, '/notes')}
      <div class="widget__empty">
        <i data-lucide="sticky-note" class="empty-state__icon" aria-hidden="true"></i>
        <div>${t('dashboard.noPinnedNotes')}</div>
      </div>
    </div>`;
  }

  const items = notes.map((n) => `
    <div class="note-item" data-route="/notes" role="button" tabindex="0"
         style="--note-color:${esc(n.color)};">
      ${n.title ? `<div class="note-item__title">${esc(n.title)}</div>` : ''}
      <div class="note-item__content">${renderMarkdownLight(n.content)}</div>
    </div>
  `).join('');

  // Breite kommt aus dem Größenklassen-System am .widget-wrapper (widget-size--2x1);
  // die frühere .widget--wide war in keinem CSS definiert und damit tot — entfernt,
  // damit Notizen wie jedes andere Widget genau ein Größen-Vokabular trägt (Critique P2).
  return `<div class="widget widget--notes">
    ${widgetHeader('pin', t('nav.notes'), notes.length, '/notes')}
    <div class="notes-grid-widget">${items}</div>
  </div>`;
}

function renderFamilyWidget(users) {
  const visible = users.slice(0, 6);
  const avatars = visible.map((u) => `
    <span class="family-widget-avatar" style="background:${esc(u.avatar_color || AVATAR_FALLBACK_COLOR)};color:${getReadableTextColor(u.avatar_color || AVATAR_FALLBACK_COLOR)}" title="${esc(u.display_name)}">
      ${u.avatar_data ? `<img src="${esc(u.avatar_data)}" alt="${esc(u.display_name)}" loading="lazy">` : esc(initials(u.display_name))}
    </span>
  `).join('');

  return `<div class="widget widget--family">
    ${widgetHeader('users', t('dashboard.familyMembers'), users.length, '/settings')}
    <div class="family-widget">
      <div class="family-widget__count">${users.length}</div>
      <div class="family-widget__meta">${t('dashboard.participantsAdded')}</div>
      <div class="family-widget__avatars">${avatars}</div>
    </div>
  </div>`;
}

function renderBudgetWidget(budget, currency) {
  const income = budget?.income || 0;
  const expenses = budget?.expenses || 0;
  const balance = budget?.balance || 0;
  const savingsRate = income > 0 ? Math.round((balance / income) * 100) : 0;
  const balanceTone = balance >= 0 ? 'positive' : 'negative';
  const hasData = (budget?.entryCount || 0) > 0;

  if (!hasData) {
    return `<div class="widget widget--budget">
      ${widgetHeader('wallet', t('dashboard.budgetOverview'), null, '/budget')}
      <div class="widget__empty">
        <i data-lucide="wallet" class="empty-state__icon" aria-hidden="true"></i>
        <div>${t('dashboard.noBudgetData')}</div>
        ${emptyStateCta('/budget', t('budget.addEntryLabel'))}
      </div>
    </div>`;
  }

  return `<div class="widget widget--budget">
    ${widgetHeader('wallet', t('dashboard.budgetOverview'), null, '/budget')}
    <div class="budget-widget">
      <div class="budget-widget__headline">
        <span>${t('dashboard.monthlyBalance')}</span>
        <strong class="budget-widget__balance budget-widget__balance--${balanceTone}">${formatCurrency(balance, currency)}</strong>
      </div>
      <div class="budget-widget__savings">
        <span>${t('dashboard.savingsRate')}</span>
        <strong>${income > 0 ? `${savingsRate}%` : '–'}</strong>
      </div>
      <div class="budget-widget__flow">
        <span class="budget-widget__flow-item budget-widget__flow-item--income">
          <span>${t('dashboard.monthlyIncome')}</span>
          <strong>${formatCurrency(income, currency)}</strong>
        </span>
        <span class="budget-widget__flow-item budget-widget__flow-item--expense">
          <span>${t('dashboard.monthlyExpenses')}</span>
          <strong>${formatCurrency(expenses, currency)}</strong>
        </span>
      </div>
      ${budget?.topExpenseCategory
        ? `<div class="budget-widget__footer">${t('dashboard.topExpense')}: <strong>${esc(budgetCategoryLabel(budget.topExpenseCategory))}</strong> · ${formatCurrency(budget.topExpenseAmount, currency)}</div>`
        : ''}
    </div>
  </div>`;
}

// --------------------------------------------------------
// Belohnungen-Widget (Familien-Punktestand)
// --------------------------------------------------------

function renderRewardsWidget(rewards) {
  const standings = Array.isArray(rewards?.standings) ? rewards.standings : [];
  if (!standings.length) {
    return `<div class="widget widget--rewards">
      ${widgetHeader('award', t('nav.rewards'), 0, '/rewards')}
      <div class="widget__empty">
        <i data-lucide="award" class="empty-state__icon" aria-hidden="true"></i>
        <div>${t('dashboard.noRewards')}</div>
        ${emptyStateCta('/rewards', t('rewards.addReward'))}
      </div>
    </div>`;
  }

  const rows = standings.map((m, i) => {
    const color = m.avatar_color || AVATAR_FALLBACK_COLOR;
    const avatarInner = m.avatar_data
      ? `<img src="${esc(m.avatar_data)}" alt="" loading="lazy">`
      : esc(initials(m.display_name));
    return `
      <div class="rewards-widget-row${i === 0 ? ' rewards-widget-row--leader' : ''}" data-route="/rewards" role="button" tabindex="0">
        <span class="rewards-widget-row__rank" aria-hidden="true">${i + 1}</span>
        <span class="rewards-widget-row__avatar" style="background:${esc(color)};color:${getReadableTextColor(color)}">${avatarInner}</span>
        <span class="rewards-widget-row__name">${esc(m.display_name)}</span>
        <span class="rewards-widget-row__points"><strong>${esc(formatPoints(m.balance))}</strong> ${esc(t('rewards.pointsUnit'))}</span>
      </div>
    `;
  }).join('');

  const pending = Number(rewards?.pending) || 0;
  const footer = pending > 0
    ? `<div class="rewards-widget__footer" data-route="/rewards" role="button" tabindex="0">
        <i data-lucide="clock" aria-hidden="true"></i>
        <span>${t('dashboard.rewardsPending', { count: pending })}</span>
      </div>`
    : '';

  const badge = Number(rewards?.participantCount) || standings.length;
  return `<div class="widget widget--rewards">
    ${widgetHeader('award', t('nav.rewards'), badge, '/rewards')}
    <div class="widget__body">
      <div class="rewards-widget">${rows}</div>
      ${footer}
    </div>
  </div>`;
}

// --------------------------------------------------------
// Gesundheit-Widget (heutige Medikamenten-Dosen)
// --------------------------------------------------------

function renderHealthWidget(health) {
  if (!health?.hasMeds) {
    return `<div class="widget widget--health">
      ${widgetHeader('heart-pulse', t('nav.health'), null, '/health')}
      <div class="widget__empty">
        <i data-lucide="heart-pulse" class="empty-state__icon" aria-hidden="true"></i>
        <div>${t('dashboard.healthNoMeds')}</div>
        ${emptyStateCta('/health', t('health.meds.add'))}
      </div>
    </div>`;
  }

  const total = Number(health?.dosesTotal) || 0;
  const taken = Number(health?.dosesTaken) || 0;
  const lowStock = Number(health?.lowStockCount) || 0;
  const pct = total > 0 ? Math.max(0, Math.min(1, taken / total)) : 0;
  const allTaken = total > 0 && taken >= total;

  const lowChip = lowStock > 0
    ? `<div class="health-widget__refill"><i data-lucide="package" aria-hidden="true"></i><span>${t('dashboard.healthRefill', { count: lowStock })}</span></div>`
    : '';

  let main;
  if (total === 0) {
    main = `<div class="health-widget__none">
      <i data-lucide="coffee" class="health-widget__none-icon" aria-hidden="true"></i>
      <span>${t('dashboard.healthNoDosesToday')}</span>
    </div>`;
  } else {
    const status = allTaken
      ? `<div class="health-widget__status health-widget__status--done"><i data-lucide="check" aria-hidden="true"></i>${t('dashboard.healthAllTaken')}</div>`
      : health?.nextDose
        ? `<div class="health-widget__next">
            <span class="health-widget__next-time">${esc(health.nextDose.time)}</span>
            <span class="health-widget__next-name">${esc(health.nextDose.name)}</span>
          </div>`
        : '';
    main = `
      <div class="health-widget__progress">
        <div class="health-widget__bar" role="img" aria-label="${t('dashboard.healthDosesProgress', { taken, total })}">
          <div class="health-widget__bar-fill${allTaken ? ' health-widget__bar-fill--done' : ''}" style="--dose-scale:${pct}"></div>
        </div>
        <div class="health-widget__count"><strong>${taken}</strong>/${total}</div>
      </div>
      ${status}
    `;
  }

  return `<div class="widget widget--health">
    ${widgetHeader('heart-pulse', t('nav.health'), null, '/health')}
    <div class="widget__body">
      <div class="health-widget">${main}${lowChip}</div>
    </div>
  </div>`;
}

// --------------------------------------------------------
// Zyklus-Widget (owner-only, opt-in)
// --------------------------------------------------------
// Strikt privat: Die Vorhersage wird client-seitig aus den nutzer-eigenen
// /health/cycle/*-Endpunkten berechnet (siehe render()) und fließt NIE in den
// familienweiten /dashboard-Payload. Zeigt Phase + Zyklustag (Mini-Ring) und die
// nächste Periode als Countdown — die eine glanceable Zahl für den Alltag.

const CYCLE_WIDGET_PHASE_KEYS = {
  [PHASE.MENSTRUATION]: 'health.cycle.phase.menstruation',
  [PHASE.FOLLICULAR]:   'health.cycle.phase.follicular',
  [PHASE.FERTILE]:      'health.cycle.phase.fertile',
  [PHASE.OVULATION]:    'health.cycle.phase.ovulation',
  [PHASE.LUTEAL]:       'health.cycle.phase.luteal',
};

// Phasenfarbe für den Ring-Bogen; Follikel-/Lutealphase tragen den Modul-Akzent.
const CYCLE_WIDGET_PHASE_COLOR = {
  [PHASE.MENSTRUATION]: 'var(--cycle-period)',
  [PHASE.FERTILE]:      'var(--cycle-fertile)',
  [PHASE.OVULATION]:    'var(--cycle-ovulation)',
};

function cycleWidgetCountdown(prediction) {
  const d = prediction.daysUntilNext;
  if (d === 0) return t('health.cycle.status.today');
  if (d < 0) return t('health.cycle.status.overdue', { count: Math.abs(d) });
  return t('health.cycle.status.inDays', { count: d });
}

function renderCycleWidget(cycle) {
  // cycle: { periods, settings } (owner-only) | null (Ladefehler) | undefined (Kachel versteckt)
  const prediction = cycle
    ? predictCycle(cycle.periods || [], cycle.settings || {})
    : { hasData: false };

  // Ohne Historie: Onboarding-Empty statt Fehlerkachel — führt in den Zyklus-Flow.
  if (!prediction.hasData) {
    return `<div class="widget widget--cycle">
      ${widgetHeader('calendar-heart', t('health.cycle.title'), null, '/health/cycle')}
      <div class="widget__empty">
        <i data-lucide="calendar-heart" class="empty-state__icon" aria-hidden="true"></i>
        <div>${t('health.cycle.emptyTitle')}</div>
        ${emptyStateCta('/health/cycle', t('health.cycle.add'))}
      </div>
    </div>`;
  }

  const phaseLabel = t(CYCLE_WIDGET_PHASE_KEYS[prediction.phase] || CYCLE_WIDGET_PHASE_KEYS[PHASE.FOLLICULAR]);
  const dayText = t('health.cycle.ring.cycleDay', { day: prediction.cycleDay });
  const countdown = cycleWidgetCountdown(prediction);
  const phaseColor = CYCLE_WIDGET_PHASE_COLOR[prediction.phase] || 'var(--module-health)';

  // Mini-Fortschrittsring: Zyklustag / Ø-Zyklus als einzelner Bogen in Phasenfarbe.
  const R = 26;
  const C = 2 * Math.PI * R;
  const frac = Math.min(1, Math.max(0, prediction.cycleDay / Math.max(1, prediction.avgCycle)));
  const lit = (frac * C).toFixed(2);
  const gap = (C - frac * C).toFixed(2);

  const ring = `
    <svg class="cycle-widget__ring" viewBox="0 0 64 64" role="img" aria-label="${esc(`${phaseLabel} · ${dayText}`)}">
      <circle class="cycle-widget__ring-track" cx="32" cy="32" r="${R}" fill="none" stroke-width="6" />
      <circle class="cycle-widget__ring-arc" cx="32" cy="32" r="${R}" fill="none" stroke="${phaseColor}"
        stroke-width="6" stroke-linecap="round" stroke-dasharray="${lit} ${gap}" transform="rotate(-90 32 32)" />
      <text class="cycle-widget__ring-num" x="32" y="32" text-anchor="middle" dominant-baseline="central">${esc(prediction.cycleDay)}</text>
    </svg>`;

  return `<div class="widget widget--cycle">
    ${widgetHeader('calendar-heart', t('health.cycle.title'), null, '/health/cycle')}
    <div class="widget__body">
      <div class="cycle-widget" data-phase="${esc(prediction.phase)}">
        ${ring}
        <div class="cycle-widget__info">
          <span class="cycle-widget__phase">${esc(phaseLabel)}</span>
          <span class="cycle-widget__next">
            <span class="cycle-widget__next-label">${esc(t('health.cycle.status.nextPeriod'))}</span>
            <span class="cycle-widget__countdown">${esc(countdown)}</span>
          </span>
          <span class="cycle-widget__date">${esc(formatDate(prediction.nextStart))}</span>
        </div>
      </div>
    </div>
  </div>`;
}

// --------------------------------------------------------
// Haushaltshilfe-Widget (Anwesenheit + offene Zahlung)
// --------------------------------------------------------

function renderHousekeepingWidget(hk, currency) {
  if (!hk?.configured) {
    return `<div class="widget widget--housekeeping">
      ${widgetHeader('paintbrush', t('nav.housekeeping'), null, '/housekeeping')}
      <div class="widget__empty">
        <i data-lucide="paintbrush" class="empty-state__icon" aria-hidden="true"></i>
        <div>${t('dashboard.housekeepingNone')}</div>
        ${emptyStateCta('/housekeeping', t('housekeeping.addTask'))}
      </div>
    </div>`;
  }

  const unpaid = Number(hk.unpaidAmount) || 0;
  const visits = Number(hk.visitsThisMonth) || 0;
  const present = Boolean(hk.present);

  const statusBlock = present
    ? `<div class="housekeeping-widget__status housekeeping-widget__status--present">
        <span class="housekeeping-widget__dot" aria-hidden="true"></span>
        <div class="housekeeping-widget__lines">
          <div class="housekeeping-widget__state">${t('dashboard.housekeepingPresent')}</div>
          <div class="housekeeping-widget__sub">${hk.workerName ? `${esc(hk.workerName)} · ` : ''}${hk.presentSince ? t('dashboard.housekeepingSince', { time: formatTime(new Date(hk.presentSince)) }) : ''}</div>
        </div>
      </div>`
    : `<div class="housekeeping-widget__status">
        <span class="housekeeping-widget__dot housekeeping-widget__dot--idle" aria-hidden="true"></span>
        <div class="housekeeping-widget__lines">
          <div class="housekeeping-widget__state">${hk.lastVisit ? t('dashboard.housekeepingLastVisit', { date: formatDate(new Date(hk.lastVisit)) }) : t('dashboard.housekeepingNoVisits')}</div>
          <div class="housekeeping-widget__sub">${t('dashboard.housekeepingVisitsMonth', { count: visits })}</div>
        </div>
      </div>`;

  const unpaidChip = unpaid > 0
    ? `<div class="housekeeping-widget__unpaid"><i data-lucide="banknote" aria-hidden="true"></i><span>${t('dashboard.housekeepingUnpaid', { amount: formatCurrency(unpaid, currency) })}</span></div>`
    : '';

  return `<div class="widget widget--housekeeping">
    ${widgetHeader('paintbrush', t('nav.housekeeping'), null, '/housekeeping')}
    <div class="widget__body">
      <div class="housekeeping-widget">${statusBlock}${unpaidChip}</div>
    </div>
  </div>`;
}

function renderTodayCard(icon, label, value, route, tone, count = null) {
  const badge = Number.isFinite(count) && count > 0
    ? `<span class="today-cockpit-card__count">${count}</span>`
    : '';
  return `
    <button type="button" class="today-cockpit-card today-cockpit-card--${tone}" data-route="${route}">
      <span class="today-cockpit-card__icon"><i data-lucide="${icon}" aria-hidden="true"></i></span>
      <span class="today-cockpit-card__label">${esc(label)}${badge}</span>
      <strong class="today-cockpit-card__value">${esc(value)}</strong>
    </button>
  `;
}

function renderTodayCockpit(data, cfg = []) {
  const highlights = buildTodayHighlights(data);
  const taskTitle = highlights.urgentTask?.title ?? t('dashboard.todayNoTasks');
  const eventTitle = highlights.nextEvent?.title ?? t('dashboard.todayNoEvents');
  const mealLabel = MEAL_LABELS()[highlights.mealType] ?? t('dashboard.todayDinner');
  const mealIcon = MEAL_ICONS[highlights.mealType] ?? 'utensils';
  const mealTitle = highlights.meal?.title ?? t('dashboard.todayNoDinner');

  // Kein Echo: ist das Modul-Widget einer Domäne sichtbar, entfällt seine
  // Cockpit-Karte — jede Domäne hat genau eine Repräsentation (Cockpit ODER
  // Widget), statt dieselbe Aufgabe/Termin doppelt zu zeigen.
  const widgetShown = (id) => Array.isArray(cfg) && cfg.some((w) => w.id === id && w.visible);

  // Leere Karten ausblenden: eine Domäne ohne Inhalt (kein Termin, keine offene
  // Aufgabe, kein geplantes Essen …) bekommt keine Cockpit-Karte, statt einen
  // „Nichts geplant"-Platzhalter zu zeigen. Betraf zuvor „Heute Essen", weil
  // dessen Widget standardmäßig ausgeblendet ist und die Karte so ohne Mahlzeit
  // sichtbar blieb.
  const hasContent = {
    tasks:    Boolean(highlights.urgentTask),
    calendar: Boolean(highlights.nextEvent),
    shopping: highlights.openShoppingCount > 0,
    meals:    Boolean(highlights.meal),
  };
  const showCard = (module) => !window.yuvomi?.isModuleDisabled(module) && !widgetShown(module) && hasContent[module];

  const cards = [
    showCard('tasks')    ? renderTodayCard('check-square', t('dashboard.todayTask'),     taskTitle, '/tasks', 'task', highlights.taskCount) : '',
    showCard('calendar') ? renderTodayCard('calendar',     t('dashboard.todayEvent'),    eventTitle, calendarEventRoute(highlights.nextEvent), 'event', highlights.eventCount) : '',
    showCard('shopping') ? renderTodayCard('shopping-cart', t('dashboard.todayShopping'), t('dashboard.todayShoppingCount', { count: highlights.openShoppingCount }), '/shopping', 'shopping') : '',
    showCard('meals')    ? renderTodayCard(mealIcon,        mealLabel,   mealTitle, '/meals', 'dinner') : '',
  ].filter(Boolean);

  // Deckt der Nutzer alle vier Domänen über Widgets ab, wäre das Cockpit leer —
  // dann entfällt der ganze Abschnitt statt einer leeren Kopfzeile.
  if (!cards.length) return '';

  return `
    <section class="today-cockpit" aria-labelledby="today-cockpit-title">
      <div class="today-cockpit__header">
        <h2 id="today-cockpit-title">${esc(t('dashboard.todayTitle'))}</h2>
      </div>
      <div class="today-cockpit__grid">
        ${cards.join('')}
      </div>
    </section>
  `;
}


function renderDashboardOverview(user, editing = false) {
  const dateLabel = formatDate(new Date());

  return `
    <section class="dashboard-overview">
      <div class="dashboard-overview__header${editing ? ' dashboard-overview__header--editing' : ''}">
        <div class="dashboard-overview__heading">
          <span class="dashboard-overview__date">${dateLabel}</span>
          <h2 class="dashboard-overview__title dashboard-overview__title--${greetingPeriod()}">${greeting(user.display_name)}</h2>
        </div>
        <div class="dashboard-overview__tools">
          ${editing ? `
          <div class="dashboard-customize-toolbar" role="toolbar" aria-label="${t('dashboard.customizeTitle')}">
            <button class="btn btn--ghost" id="dashboard-customize-reset">${t('dashboard.customizeReset')}</button>
            <button class="btn btn--secondary" id="dashboard-customize-cancel">${t('common.cancel')}</button>
            <button class="btn btn--primary" id="dashboard-customize-save">${t('common.save')}</button>
          </div>` : ''}
          <button class="dashboard-icon-btn" id="dashboard-customize-btn"
                  aria-label="${editing ? t('dashboard.customizeExit') : t('dashboard.customize')}"
                  title="${editing ? t('dashboard.customizeExit') : t('dashboard.customize')}"
                  aria-pressed="${editing ? 'true' : 'false'}">
            <i data-lucide="${editing ? 'x' : 'settings-2'}" aria-hidden="true"></i>
          </button>
        </div>
      </div>
    </section>
  `;
}

function widgetSizeClass(size) {
  return WIDGET_SIZE_OPTIONS.includes(size) ? `widget-size--${size}` : 'widget-size--1x1';
}

function renderSizeMiniGrid(size) {
  return `<span class="widget-size-mini" aria-hidden="true">${renderSizeMiniGridCells(size)}</span>`;
}

function renderSizeMiniGridCells(size) {
  const [cols, rows] = size.split('x').map(Number);
  return Array.from({ length: 16 }, (_, i) => {
    const col = (i % 4) + 1;
    const row = Math.floor(i / 4) + 1;
    return `<span class="${col <= cols && row <= rows ? 'is-active' : ''}"></span>`;
  }).join('');
}

function renderWidgetCustomizeControls(w, index = 0, total = 1) {
  const isFirst = index === 0;
  const isLast = index === total - 1;
  const activeSize = nearestPreset(w.size);

  // Segmentiertes Größen-Steuerelement: klickbare Mini-Grid-Presets ersetzen
  // die frühere Kombination aus dekorativem Mini-Grid + „Größe"-Label + 132px-
  // <select> (Critique P1: doppelte Kontrolle + Overflow auf 1×1-Kacheln). Jeder
  // Button zeigt seine Form direkt und markiert die aktive Größe.
  const sizeButtons = WIDGET_SIZE_PRESETS.map((p) => {
    const active = p.value === activeSize;
    return `<button type="button" class="widget-size-btn${active ? ' widget-size-btn--active' : ''}"
              data-widget-size-preset="${p.value}" data-widget-id="${esc(w.id)}"
              aria-pressed="${active ? 'true' : 'false'}" aria-label="${esc(t(p.labelKey))}" title="${esc(t(p.labelKey))}">
        ${renderSizeMiniGrid(p.value)}
      </button>`;
  }).join('');

  return `
    <div class="widget-edit-controls" data-widget-controls>
      <button type="button" class="widget-edit-controls__handle" data-widget-drag-handle
              aria-label="${t('dashboard.customizeReorderHandle')}" aria-keyshortcuts="ArrowUp ArrowDown">
        <i data-lucide="grip-vertical" aria-hidden="true"></i>
      </button>
      <div class="widget-edit-controls__move">
        <button type="button" class="widget-edit-controls__move-btn" data-widget-move="up" data-widget-id="${esc(w.id)}"
                ${isFirst ? 'disabled' : ''} aria-label="${t('dashboard.customizeMoveUp')}">
          <i data-lucide="chevron-up" aria-hidden="true"></i>
        </button>
        <button type="button" class="widget-edit-controls__move-btn" data-widget-move="down" data-widget-id="${esc(w.id)}"
                ${isLast ? 'disabled' : ''} aria-label="${t('dashboard.customizeMoveDown')}">
          <i data-lucide="chevron-down" aria-hidden="true"></i>
        </button>
      </div>
      <div class="widget-edit-controls__size" role="group" aria-label="${t('dashboard.customizeSizeFor', { widget: widgetLabel(w.id) })}">
        ${sizeButtons}
      </div>
      <button type="button" class="widget-edit-controls__hide" data-widget-hide="${esc(w.id)}" aria-label="${t('dashboard.customizeHide', { widget: widgetLabel(w.id) })}">
        <i data-lucide="eye-off" aria-hidden="true"></i>
      </button>
    </div>
  `;
}

// Wieder-Einblenden-Leiste: schließt die Einbahnstraße des Inline-Modus. Ein im
// Edit-Modus ausgeblendetes Widget landet als Chip hier und lässt sich mit einem
// Klick zurückholen — so ist der Inline-Editor allein vollständig (Zeigen +
// Verstecken + Größe + Reihenfolge) und das frühere zweite Editor-Modal entfällt.
function renderHiddenWidgetsTray(cfg) {
  const hidden = cfg.filter((w) => !w.visible && WIDGET_IDS.includes(w.id) && isWidgetModuleEnabled(w.id));
  if (!hidden.length) return '';
  const chips = hidden.map((w) => `
    <button type="button" class="widget-restore-chip" data-widget-show="${esc(w.id)}"
            aria-label="${t('dashboard.customizeShow', { widget: widgetLabel(w.id) })}">
      <i data-lucide="${widgetIcon(w.id)}" class="widget-restore-chip__icon" aria-hidden="true"></i>
      <span class="widget-restore-chip__label">${widgetLabel(w.id)}</span>
      <i data-lucide="plus" class="widget-restore-chip__add" aria-hidden="true"></i>
    </button>`).join('');
  return `
    <section class="widget-restore" aria-label="${t('dashboard.customizeHiddenTitle')}">
      <h3 class="widget-restore__title">${t('dashboard.customizeHiddenTitle')}</h3>
      <div class="widget-restore__chips">${chips}</div>
    </section>
  `;
}

function renderDashboardLayout(cfg, data, weather, currency, { editing = false, visibleMealTypes = MEAL_ORDER } = {}) {
  const widgetById = {
    tasks: () => renderUrgentTasks(data.urgentTasks ?? []),
    calendar: () => renderUpcomingEvents(data.upcomingEvents ?? []),
    birthdays: () => renderUpcomingBirthdays(data.birthdays ?? []),
    budget: () => renderBudgetWidget(data.budget ?? {}, currency),
    rewards: () => renderRewardsWidget(data.rewards ?? {}),
    health: () => renderHealthWidget(data.health ?? {}),
    cycle: () => renderCycleWidget(data.cycle),
    housekeeping: () => renderHousekeepingWidget(data.housekeeping ?? {}, currency),
    family: () => renderFamilyWidget(data.users ?? []),
    meals: () => renderTodayMeals(data.todayMeals ?? [], visibleMealTypes),
    notes: () => renderPinnedNotes(data.pinnedNotes ?? []),
    shopping: () => renderShoppingLists(data.shoppingLists ?? []),
    weather: () => (weather ? renderWeatherWidget(weather) : ''),
  };

  const tiles = cfg
    .filter((w) => w.visible && widgetById[w.id] && isWidgetModuleEnabled(w.id))
    .map((w, index, arr) => {
      // Widget-weise Fehler-Isolation: wirft ein einzelner Renderer (kaputtes oder
      // fehlendes Daten-Slice), fällt nur dieses Widget auf eine ruhige Inline-
      // Fehlerkachel zurück — die übrigen Widgets und das Cockpit bleiben nutzbar,
      // statt dass ein Payload-Defekt das ganze Grid killt (Critique P2).
      let html;
      try {
        html = widgetById[w.id]();
      } catch (err) {
        console.error(`[dashboard] Widget "${w.id}" konnte nicht gerendert werden`, err);
        html = renderWidgetError(w.id);
      }
      if (!html) return '';
      return `<div class="widget-wrapper ${widgetSizeClass(w.size)} ${editing ? 'widget-wrapper--editing' : ''}"
                   data-widget-id="${esc(w.id)}" ${editing ? 'draggable="true"' : ''}>
        ${editing ? renderWidgetCustomizeControls(w, index, arr.length) : ''}
        ${html}
      </div>`;
    })
    .join('');

  // Alle Widgets ausgeblendet: kein toter Screen, sondern ein Hinweis zurück
  // in die Anpassung (das Cockpit oben bleibt als Orientierung erhalten).
  const gridInner = tiles || `
    <div class="dashboard-empty-grid">
      <i data-lucide="layout-dashboard" class="empty-state__icon" aria-hidden="true"></i>
      <p>${t('dashboard.allWidgetsHidden')}</p>
    </div>
  `;
  // Beim Bearbeiten und bei bewusst umsortierten Layouts die Quellordnung bewahren
  // (kein dense-Umpacken); der Autor-Default darf dicht packen.
  const preserveOrder = (editing || isUserOrderedConfig(cfg)) ? ' dashboard__grid--preserve-order' : '';
  const grid = `<div class="dashboard__grid ${editing ? 'dashboard__grid--editing' : ''}${preserveOrder}" id="dashboard-widget-grid">${gridInner}</div>`;
  // Im Bearbeiten-Modus folgt die Wieder-Einblenden-Leiste dem Grid, damit
  // ausgeblendete Widgets nicht in einer Sackgasse verschwinden.
  return editing ? `${grid}${renderHiddenWidgetsTray(cfg)}` : grid;
}

function renderDashboardSkeleton() {
  const tiles = DEFAULT_WIDGET_CONFIG
    .filter((w) => w.visible)
    .map((w) => `<div class="widget-wrapper ${widgetSizeClass(w.size)}">${skeletonWidget(3)}</div>`)
    .join('');
  return `
    <section class="dashboard-overview">
      <div class="dashboard-overview__header">
        <div class="dashboard-overview__heading">
          <div class="skeleton skeleton-line skeleton-line--short"></div>
          <div class="skeleton skeleton-line skeleton-line--medium"></div>
        </div>
      </div>
    </section>
    <div class="dashboard__grid">${tiles}</div>
  `;
}

// Distinkter Fehlerzustand: verhindert, dass ein Ladefehler wie ein ruhiger,
// leerer Tag aussieht (falsch beruhigend). Bietet einen Retry, der neu lädt.
// Die Meldung unterscheidet Sitzungsablauf (401/403) und Serverfehler (5xx)
// von einem generischen Verbindungsproblem — Retry hilft nicht überall gleich.
function renderDashboardError(status = null) {
  const messageKey = status === 401 || status === 403
    ? 'dashboard.loadErrorSession'
    : (typeof status === 'number' && status >= 500)
      ? 'dashboard.loadErrorServer'
      : 'dashboard.loadError';
  return `
    <div class="dashboard-error" role="alert">
      <i data-lucide="cloud-off" class="dashboard-error__icon" aria-hidden="true"></i>
      <p class="dashboard-error__text">${t(messageKey)}</p>
      <button type="button" class="btn btn--secondary" id="dashboard-retry">
        <i data-lucide="refresh-cw" aria-hidden="true"></i>
        ${t('common.retry')}
      </button>
    </div>
  `;
}

// Inline-Fehlerkachel für ein einzelnes Widget (siehe Fehler-Isolation in
// renderDashboardLayout). Nutzt die vorhandene .widget/.widget__empty-Grammatik,
// damit sie sich ruhig einreiht statt wie ein Systemfehler zu schreien.
function renderWidgetError(id) {
  return `<div class="widget widget--error" role="alert">
    <div class="widget__header">
      <span class="widget__title">
        <i data-lucide="${widgetIcon(id)}" class="widget__title-icon" aria-hidden="true"></i>
        ${widgetLabel(id)}
      </span>
    </div>
    <div class="widget__empty">
      <i data-lucide="cloud-off" class="empty-state__icon" aria-hidden="true"></i>
      <div>${t('dashboard.widgetError')}</div>
      <button type="button" class="btn btn--secondary widget__retry" data-widget-retry="${esc(id)}">
        <i data-lucide="refresh-cw" aria-hidden="true"></i>
        ${t('common.retry')}
      </button>
    </div>
  </div>`;
}

// --------------------------------------------------------
// Shopping-Widget
// --------------------------------------------------------

function renderShoppingLists(lists) {
  if (!lists.length) {
    return `<div class="widget widget--shopping">
      ${widgetHeader('shopping-cart', t('nav.shopping'), 0, '/shopping')}
      <div class="widget__empty">
        <i data-lucide="shopping-cart" class="empty-state__icon" aria-hidden="true"></i>
        <div>${t('dashboard.noShoppingLists')}</div>
        ${emptyStateCta('/shopping', t('shopping.newListButton'))}
      </div>
    </div>`;
  }

  const totalOpen = lists.reduce((sum, l) => sum + l.open_count, 0);

  const listsHtml = lists.map((list) => {
    const progress = list.total_count > 0
      ? Math.round(((list.total_count - list.open_count) / list.total_count) * 100)
      : 0;

    const itemsHtml = list.items.map((item) => `
      <div class="shopping-widget-item">
        <span class="shopping-widget-item__dot"></span>
        <span class="shopping-widget-item__name">${esc(item.name)}</span>
        ${item.quantity ? `<span class="shopping-widget-item__qty">${esc(item.quantity)}</span>` : ''}
      </div>
    `).join('');

    const moreCount = list.open_count - list.items.length;

    return `
      <div class="shopping-widget-list" data-route="/shopping" role="button" tabindex="0">
        <div class="shopping-widget-list__header">
          <span class="shopping-widget-list__name">${esc(list.name)}</span>
          <span class="shopping-widget-list__count">${list.total_count - list.open_count}/${list.total_count}</span>
        </div>
        <div class="shopping-widget-list__progress">
          <div class="shopping-widget-list__bar" style="--progress-scale:${progress / 100}"></div>
        </div>
        <div class="shopping-widget-list__items">
          ${itemsHtml}
          ${moreCount > 0 ? `<div class="shopping-widget-item shopping-widget-item--more">${t('dashboard.shoppingMore', { count: moreCount })}</div>` : ''}
        </div>
      </div>
    `;
  }).join('');

  return `<div class="widget widget--shopping">
    ${widgetHeader('shopping-cart', t('nav.shopping'), totalOpen, '/shopping')}
    <div class="widget__body">${listsHtml}</div>
  </div>`;
}

// --------------------------------------------------------
// Wetter-Widget
// --------------------------------------------------------

const WEATHER_ICON_BASE = '/api/v1/weather/icon/';

function renderWeatherWidget(weather) {
  if (!weather) return '';

  const { city, current, forecast, units, provider } = weather;
  const isOm = provider === 'open-meteo';

  // OWM-Legacy kann 'standard' (Kelvin) liefern; Open-Meteo nur metric/imperial.
  const unitSymbol = units === 'imperial' ? '°F' : units === 'standard' ? 'K' : '°C';
  const windUnit   = units === 'imperial' ? 'mph' : 'km/h';

  // Open-Meteo liefert Lucide-Icon-Namen + wmo.*-i18n-Keys; OWM (Legacy) liefert
  // OWM-Icon-Codes (via /icon-Proxy) + bereits lokalisierten Beschreibungstext.
  const descText = (desc) => (isOm ? t(desc) : desc);
  function iconHtml(icon, cls, size, desc) {
    if (isOm) {
      return `<i data-lucide="${esc(icon)}" class="${cls}" aria-hidden="true"></i>`;
    }
    return `<img class="${cls}" src="${WEATHER_ICON_BASE}${esc(icon)}"
             alt="${esc(desc)}" width="${size}" height="${size}" loading="lazy">`;
  }

  const forecastHtml = forecast.map((d, i) => {
    const date = new Date(d.date + 'T12:00:00');
    const label = new Intl.DateTimeFormat(getLocale(), { weekday: 'short' }).format(date);
    const extraCls = i >= 3 ? ' weather-forecast__day--extended' : '';
    return `
      <div class="weather-forecast__day${extraCls}">
        <div class="weather-forecast__label">${label}</div>
        ${iconHtml(d.icon, 'weather-forecast__icon', 32, descText(d.desc))}
        <div class="weather-forecast__temps">
          <span class="weather-forecast__high">${d.temp_max}°</span>
          <span class="weather-forecast__low">${d.temp_min}°</span>
        </div>
      </div>`;
  }).join('');

  return `
    <div class="widget widget--weather weather-widget" id="weather-widget">
      <button class="weather-widget__refresh" id="weather-refresh-btn" aria-label="${t('dashboard.weatherRefresh')}" title="${t('dashboard.weatherRefreshTitle')}">
        <i data-lucide="refresh-cw" class="icon-md" aria-hidden="true"></i>
      </button>
      <div class="weather-widget__inner">
        <div class="weather-widget__main">
          <div class="weather-widget__left">
            <div class="weather-widget__temp">${esc(current.temp)}${unitSymbol}</div>
            <div class="weather-widget__desc">${esc(descText(current.desc))}</div>
            <div class="weather-widget__city">${esc(city)}</div>
            <div class="weather-widget__meta">
              ${t('dashboard.weatherFeelsLike', { temp: current.feels_like, humidity: current.humidity, wind: current.wind_speed, windUnit })}
            </div>
          </div>
          ${iconHtml(current.icon, 'weather-widget__icon', 80, descText(current.desc))}
        </div>
        ${forecast.length ? `<div class="weather-forecast">${forecastHtml}</div>` : ''}
      </div>
    </div>`;
}

// --------------------------------------------------------
// FAB Speed-Dial
// --------------------------------------------------------

const FAB_ACTIONS = () => [
  { route: '/tasks',    label: t('dashboard.fabTask'),     icon: 'check-square'   },
  { route: '/calendar', label: t('dashboard.fabCalendar'), icon: 'calendar-plus'  },
  { route: '/shopping', label: t('dashboard.fabShopping'), icon: 'shopping-cart'  },
  { route: '/notes',    label: t('dashboard.fabNote'),     icon: 'sticky-note'    },
];

function renderFab() {
  const actionsHtml = FAB_ACTIONS().map((a) => `
    <button type="button" class="fab-action" data-route="${a.route}" tabindex="-1"
            aria-label="${a.label}">
      <span class="fab-action__label">${a.label}</span>
      <span class="fab-action__btn" aria-hidden="true">
        <i data-lucide="${a.icon}" aria-hidden="true"></i>
      </span>
    </button>
  `).join('');

  return `
    <div class="fab-backdrop" id="fab-backdrop"></div>
    <div class="fab-container" id="fab-container">
      <button class="fab-main" id="fab-main" aria-label="${t('nav.quickActions')}" aria-expanded="false">
        <i data-lucide="plus" aria-hidden="true"></i>
      </button>
      <div class="fab-actions" id="fab-actions" aria-hidden="true">
        ${actionsHtml}
      </div>
    </div>
  `;
}

function initFab(container, signal) {
  const fabMain     = container.querySelector('#fab-main');
  const fabActions  = container.querySelector('#fab-actions');
  const fabBackdrop = container.querySelector('#fab-backdrop');
  if (!fabMain) return;

  // "Neu"-Button-Selector auf der jeweiligen Zielseite
  const FAB_NEW_BTN = {
    '/tasks':    '#btn-new-task',
    '/calendar': '#fab-new-event',
    '/shopping': '#fab-new-item',
    '/notes':    '#fab-new-note',
  };

  let open = false;

  function toggleFab(force) {
    open = force !== undefined ? force : !open;
    fabMain.classList.toggle('fab-main--open', open);
    fabMain.setAttribute('aria-expanded', String(open));
    fabActions.classList.toggle('fab-actions--visible', open);
    fabActions.setAttribute('aria-hidden', String(!open));
    fabBackdrop?.classList.toggle('fab-backdrop--visible', open);
    fabActions.querySelectorAll('.fab-action').forEach((el) => {
      el.tabIndex = open ? 0 : -1;
    });
    if (window.lucide) window.lucide.createIcons({ el: container });
  }

  fabMain.addEventListener('click', (e) => { e.stopPropagation(); toggleFab(); });

  fabActions.querySelectorAll('[data-route]').forEach((el) => {
    const go = async () => {
      toggleFab(false);
      await window.yuvomi.navigate(el.dataset.route);
      const btnSelector = FAB_NEW_BTN[el.dataset.route];
      if (btnSelector) document.querySelector(btnSelector)?.click();
    };
    el.addEventListener('click', go);
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); }
    });
  });

  document.addEventListener('click', () => { if (open) toggleFab(false); }, { signal });
}

// --------------------------------------------------------
// Task Quick-Action Modal
// --------------------------------------------------------

function openTaskQuickAction(taskId, taskTitle, rerender) {
  openModal({
    title: taskTitle,
    size: 'sm',
    content: `
      <div class="modal-actions">
        <button type="button" class="btn btn--ghost" data-action="edit">
          <i data-lucide="edit-2" style="width:16px;height:16px;" aria-hidden="true"></i>
          ${t('common.edit')}
        </button>
        <button type="button" class="btn btn--primary" data-action="done">
          <i data-lucide="check-circle" style="width:16px;height:16px;" aria-hidden="true"></i>
          ${t('tasks.kanbanMoveToDone')}
        </button>
      </div>
    `,
    onSave: (panel) => {
      panel.querySelector('[data-action="done"]').addEventListener('click', async () => {
        try {
          await api.patch(`/tasks/${taskId}/status`, { status: 'done' });
          closeModal({ force: true });
          window.yuvomi?.showToast(t('tasks.swipedDoneToast'), 'success');
          rerender();
        } catch (err) {
          window.yuvomi?.showToast(err.message, 'danger');
        }
      });
      panel.querySelector('[data-action="edit"]').addEventListener('click', () => {
        closeModal({ force: true });
        window.yuvomi.navigate(`/tasks?open=${taskId}`);
      });
    },
  });
}

// --------------------------------------------------------
// Navigations-Links verdrahten
// --------------------------------------------------------

function wireLinks(container, rerender, { editing = false } = {}) {
  container.querySelectorAll('[data-route]').forEach((el) => {
    if (el.id === 'fab-main' || el.closest('#fab-actions')) return;
    if (editing && el.closest('.widget-wrapper--editing')) return;
    const go = () => window.yuvomi.navigate(el.dataset.route);
    if (el.tagName === 'A') {
      el.addEventListener('click', (e) => { e.preventDefault(); go(); });
    } else {
      el.addEventListener('click', go);
      el.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); }
      });
    }
  });

  // Task-Items öffnen Quick-Action-Modal statt direkt zu navigieren
  if (editing) return;
  container.querySelectorAll('.task-item[data-task-id]').forEach((el) => {
    const show = () => openTaskQuickAction(el.dataset.taskId, el.dataset.taskTitle, rerender);
    el.addEventListener('click', show);
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); show(); }
    });
  });
}

function reorderWidgetConfig(config, fromId, toId, placement = 'before') {
  const fromIdx = config.findIndex((w) => w.id === fromId);
  let toIdx = config.findIndex((w) => w.id === toId);
  if (fromIdx === -1 || toIdx === -1 || fromIdx === toIdx) return config;
  const next = config.map((w) => ({ ...w }));
  const [moved] = next.splice(fromIdx, 1);
  if (fromIdx < toIdx) toIdx -= 1;
  if (placement === 'after') toIdx += 1;
  next.splice(toIdx, 0, moved);
  return next.map((w, i) => ({ ...w, order: i }));
}

function closestWidgetDrop(grid, event, draggedId) {
  const candidates = [...grid.querySelectorAll('.widget-wrapper[data-widget-id]')]
    .filter((item) => item.dataset.widgetId !== draggedId);
  if (!candidates.length) return null;

  let nearest = null;
  let nearestDistance = Number.POSITIVE_INFINITY;
  for (const item of candidates) {
    const rect = item.getBoundingClientRect();
    const centerX = rect.left + rect.width / 2;
    const centerY = rect.top + rect.height / 2;
    const dx = event.clientX - centerX;
    const dy = event.clientY - centerY;
    const distance = (dy * dy * 1.7) + (dx * dx);
    if (distance < nearestDistance) {
      nearestDistance = distance;
      nearest = { item, rect };
    }
  }
  if (!nearest) return null;

  const sameRow = event.clientY >= nearest.rect.top && event.clientY <= nearest.rect.bottom;
  const placement = sameRow
    ? (event.clientX > nearest.rect.left + nearest.rect.width / 2 ? 'after' : 'before')
    : (event.clientY > nearest.rect.top + nearest.rect.height / 2 ? 'after' : 'before');

  return { id: nearest.item.dataset.widgetId, placement, item: nearest.item };
}

function updateWidgetConfig(config, id, patch) {
  return config.map((w) => w.id === id ? { ...w, ...patch } : w)
    .map((w, i) => ({ ...w, order: i }));
}

// --------------------------------------------------------
// Haupt-Render
// --------------------------------------------------------

// Dependencies injiziert, damit die Funktion ohne DOM/`navigator`-Globals testbar ist.
export async function maybeUpdateAutoLocation({ autoLocateEnabled, geolocation, putPreferences }) {
  if (!autoLocateEnabled || !geolocation) return false;
  try {
    const position = await new Promise((resolve, reject) => {
      geolocation.getCurrentPosition(resolve, reject, { enableHighAccuracy: true, timeout: 8000 });
    });
    await putPreferences({
      weather_user: {
        lat: position.coords.latitude.toFixed(4),
        lon: position.coords.longitude.toFixed(4),
        // Stadt-Label gehört zu den alten Koordinaten — Override löschen, damit das Widget
        // auf die "lat, lon"-Anzeige zurückfällt statt einen veralteten Namen zu zeigen.
        city: null,
      },
    });
    return true;
  } catch {
    return false;
  }
}

export async function render(container, { user }) {
  _fabController?.abort();
  _fabController = new AbortController();

  setHtml(container, `
    <div class="dashboard">
      <h1 class="sr-only">${t('dashboard.title')}</h1>
      <div class="dashboard-shell" id="dashboard-shell">
        ${renderDashboardSkeleton()}
      </div>
    </div>
    ${renderFab()}
  `);

  let data         = { upcomingEvents: [], urgentTasks: [], todayMeals: [], pinnedNotes: [], shoppingLists: [], birthdays: [], users: [], budget: {}, rewards: {}, health: {}, housekeeping: {} };
  let weather      = null;
  let weatherAutoLocate = false;
  let widgetConfig = DEFAULT_WIDGET_CONFIG;
  let savedWidgetConfig = DEFAULT_WIDGET_CONFIG;
  let isCustomizing = false;
  let currency     = 'EUR';
  let visibleMealTypes = MEAL_ORDER;
  let loadFailed   = false;
  let loadErrorStatus = null;
  try {
    const [dashRes, weatherRes, prefsRes] = await Promise.all([
      api.get('/dashboard'),
      api.get(`/weather?lang=${encodeURIComponent(getLocale())}`).catch(() => ({ data: null })),
      api.get('/preferences').catch(() => ({ data: {} })),
    ]);
    data         = dashRes;
    weather      = weatherRes.data ?? null;
    weatherAutoLocate = Boolean(prefsRes.data?.weather_user?.auto_locate ?? prefsRes.data?.weather_auto_locate);
    widgetConfig = normalizeDashboardConfig(prefsRes.data?.dashboard_widgets ?? DEFAULT_WIDGET_CONFIG);
    savedWidgetConfig = widgetConfig.map((w) => ({ ...w }));
    currency     = prefsRes.data?.currency ?? 'EUR';
    visibleMealTypes = normalizeVisibleMealTypes(prefsRes.data?.visible_meal_types);
  } catch (err) {
    console.error('[Dashboard] Ladefehler:', err.message, 'Status:', err.status ?? 'network');
    loadFailed = true;
    loadErrorStatus = Number.isFinite(err?.status) ? err.status : null;
  }

  // Zyklus-Slice strikt owner-only nachladen: Zyklusdaten sind privat und dürfen
  // nicht in den familienweiten /dashboard-Payload. Genau einmal (data.cycle bleibt
  // sonst undefined = „noch nie geladen"). Ein Fehler lässt die Kachel auf ihren
  // Onboarding-Empty fallen, statt das Dashboard zu kippen.
  async function ensureCycleSlice() {
    if (data.cycle !== undefined) return;
    if (window.yuvomi?.isModuleDisabled('health')) return;
    try {
      const [periodsRes, settingsRes] = await Promise.all([
        api.get('/health/cycle/periods'),
        api.get('/health/cycle/settings').catch(() => ({ data: {} })),
      ]);
      data.cycle = { periods: periodsRes.data || [], settings: settingsRes.data || {} };
    } catch (err) {
      console.error('[Dashboard] Zyklus-Slice Ladefehler:', err?.message);
      data.cycle = null;
    }
  }

  // Nur wenn die opt-in-Kachel sichtbar ist — die Mehrheit ohne aktivierte Kachel
  // löst keinen Request aus.
  if (!loadFailed && widgetConfig.some((w) => w.id === 'cycle' && w.visible)) {
    await ensureCycleSlice();
  }

  const rerender = () => render(container, { user });

  // Einziger Persist-Pfad für Inline- UND Modal-Speichern. Legt vor dem Schreiben
  // einen Schnappschuss an und bietet — wenn sich etwas geändert hat — im Toast ein
  // „Rückgängig" an, das den vorherigen Stand wiederherstellt (inkl. Server).
  async function persistWidgetConfig(nextConfig) {
    const previousConfig = savedWidgetConfig.map((w) => ({ ...w }));
    widgetConfig = nextConfig.map((w) => ({ ...w }));
    await api.put('/preferences', { dashboard_widgets: widgetConfig });
    savedWidgetConfig = widgetConfig.map((w) => ({ ...w }));
    isCustomizing = false;
    // Wird die Zyklus-Kachel gerade erst eingeblendet, ihren owner-only Slice
    // nachladen — sonst zeigte sie fälschlich den Empty-State bis zum Reload.
    if (widgetConfig.some((w) => w.id === 'cycle' && w.visible)) await ensureCycleSlice();
    rebuildDashboard(widgetConfig);

    const changed = !sameWidgetConfig(previousConfig, widgetConfig);
    const onUndo = changed
      ? async () => {
          try {
            widgetConfig = previousConfig.map((w) => ({ ...w }));
            await api.put('/preferences', { dashboard_widgets: widgetConfig });
            savedWidgetConfig = widgetConfig.map((w) => ({ ...w }));
          } catch {
            window.yuvomi?.showToast(t('common.errorGeneric'), 'error');
          }
          isCustomizing = false;
          rebuildDashboard(widgetConfig);
        }
      : null;
    window.yuvomi?.showToast(t('dashboard.customizeSaved'), 'success', onUndo ? 6000 : 1500, onUndo);
  }

  async function saveDashboardConfig() {
    try {
      await persistWidgetConfig(widgetConfig);
    } catch {
      window.yuvomi?.showToast(t('common.errorGeneric'), 'error');
    }
  }

  function cancelDashboardConfig() {
    widgetConfig = savedWidgetConfig.map((w) => ({ ...w }));
    isCustomizing = false;
    rebuildDashboard(widgetConfig);
  }

  async function resetDashboardConfig() {
    const confirmed = await confirmModal(t('dashboard.customizeResetConfirm'), {
      confirmLabel: t('dashboard.customizeReset'),
    });
    if (!confirmed) return;
    widgetConfig = DEFAULT_WIDGET_CONFIG.map((w) => ({ ...w }));
    rebuildDashboard(widgetConfig);
  }

  function wireDashboardEditMode() {
    if (!isCustomizing) return;
    const grid = container.querySelector('#dashboard-widget-grid');
    if (!grid) return;
    let draggedId = '';
    let currentDrop = null;

    const clearDropHint = () => {
      grid.querySelectorAll('.widget-wrapper--drop-before, .widget-wrapper--drop-after').forEach((el) => {
        el.classList.remove('widget-wrapper--drop-before', 'widget-wrapper--drop-after');
      });
    };

    const updateDropHint = (event) => {
      if (!draggedId) return null;
      clearDropHint();
      currentDrop = closestWidgetDrop(grid, event, draggedId);
      if (currentDrop) {
        currentDrop.item.classList.add(currentDrop.placement === 'after' ? 'widget-wrapper--drop-after' : 'widget-wrapper--drop-before');
      }
      return currentDrop;
    };

    grid.querySelectorAll('.widget-wrapper[data-widget-id]').forEach((wrapper) => {
      wrapper.addEventListener('dragstart', (event) => {
        draggedId = wrapper.dataset.widgetId;
        event.dataTransfer.effectAllowed = 'move';
        event.dataTransfer.setData('text/plain', draggedId);
        wrapper.classList.add('widget-wrapper--dragging');
      });
      wrapper.addEventListener('dragend', () => {
        draggedId = '';
        wrapper.classList.remove('widget-wrapper--dragging');
        currentDrop = null;
        clearDropHint();
      });
    });

    grid.addEventListener('dragover', (event) => {
      event.preventDefault();
      event.dataTransfer.dropEffect = 'move';
      updateDropHint(event);
    });

    grid.addEventListener('dragleave', (event) => {
      if (!grid.contains(event.relatedTarget)) {
        currentDrop = null;
        clearDropHint();
      }
    });

    grid.addEventListener('drop', (event) => {
      event.preventDefault();
      const fromId = event.dataTransfer.getData('text/plain') || draggedId;
      const drop = currentDrop || updateDropHint(event);
      if (fromId && drop) {
        widgetConfig = reorderWidgetConfig(widgetConfig, fromId, drop.id, drop.placement);
        rebuildDashboard(widgetConfig);
      }
    });

    grid.querySelectorAll('[data-widget-size-preset]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const size = btn.dataset.widgetSizePreset;
        if (!WIDGET_SIZE_OPTIONS.includes(size)) return;
        widgetConfig = updateWidgetConfig(widgetConfig, btn.dataset.widgetId, { size });
        rebuildDashboard(widgetConfig);
      });
    });

    grid.querySelectorAll('[data-widget-hide]').forEach((btn) => {
      btn.addEventListener('click', () => {
        widgetConfig = updateWidgetConfig(widgetConfig, btn.dataset.widgetHide, { visible: false });
        rebuildDashboard(widgetConfig);
      });
    });

    // Wieder-Einblenden aus der Tray-Leiste (außerhalb des Grids, daher container-
    // weit gesucht): der Gegenpart zum Ausblenden, macht den Inline-Editor komplett.
    container.querySelectorAll('[data-widget-show]').forEach((btn) => {
      btn.addEventListener('click', () => {
        widgetConfig = updateWidgetConfig(widgetConfig, btn.dataset.widgetShow, { visible: true });
        rebuildDashboard(widgetConfig);
      });
    });

    // Reorder ohne HTML5-DnD (das feuert nicht per Finger und ist nicht per
    // Tastatur bedienbar). Ein Pfad für drei Auslöser: Touch-Up/Down-Buttons,
    // Desktop-Grip-Pfeiltasten und (indirekt) das Modal — alle über den Nachbarn
    // aus der gerenderten Grid-Reihenfolge und dasselbe reorderWidgetConfig.
    const moveWidget = (id, dir) => {
      const wrapper = grid.querySelector(`.widget-wrapper[data-widget-id="${CSS.escape(id)}"]`);
      const sibling = dir === 'up' ? wrapper?.previousElementSibling : wrapper?.nextElementSibling;
      const siblingId = sibling?.dataset?.widgetId;
      if (!id || !siblingId) return false;
      widgetConfig = reorderWidgetConfig(widgetConfig, id, siblingId, dir === 'up' ? 'before' : 'after');
      rebuildDashboard(widgetConfig);
      return true;
    };

    grid.querySelectorAll('[data-widget-move]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const id = btn.dataset.widgetId;
        const dir = btn.dataset.widgetMove;
        if (!moveWidget(id, dir)) return;
        // Fokus dem bewegten Widget nachführen (Tastatur-Kontinuität): gleiche
        // Richtung, sonst die noch aktive Gegenrichtung.
        const movedWrapper = container.querySelector(`.widget-wrapper[data-widget-id="${CSS.escape(id)}"]`);
        const sameDir = movedWrapper?.querySelector(`[data-widget-move="${dir}"]:not([disabled])`);
        const anyMove = movedWrapper?.querySelector('[data-widget-move]:not([disabled])');
        (sameDir ?? anyMove)?.focus();
      });
    });

    // Desktop-Tastatur: der Grip ist ein fokussierbarer Button — Pfeil hoch/runter
    // ordnet um. Schließt die Inline-Reorder-Lücke für Tastatur-Nutzer, ohne die
    // schmale Edit-Leiste mit zusätzlichen Buttons zu überladen (Drag bleibt Maus).
    grid.querySelectorAll('[data-widget-drag-handle]').forEach((handle) => {
      handle.addEventListener('keydown', (event) => {
        const dir = event.key === 'ArrowUp' ? 'up' : event.key === 'ArrowDown' ? 'down' : null;
        if (!dir) return;
        event.preventDefault();
        const id = handle.closest('.widget-wrapper[data-widget-id]')?.dataset.widgetId;
        if (moveWidget(id, dir)) {
          container.querySelector(`.widget-wrapper[data-widget-id="${CSS.escape(id)}"] [data-widget-drag-handle]`)?.focus();
        }
      });
    });
  }

  function rebuildDashboard(cfg) {
    const shell = container.querySelector('#dashboard-shell');
    if (!shell) return;
    if (loadFailed) {
      setHtml(shell, `
        ${renderDashboardOverview(user, false)}
        ${renderDashboardError(loadErrorStatus)}
      `);
      if (window.lucide) window.lucide.createIcons({ el: shell });
      container.querySelector('#dashboard-retry')?.addEventListener('click', rerender, { signal: _fabController.signal });
      return;
    }
    // Signature-„Heute"-Masthead: Begrüßung und Glance-Cockpit teilen sich EIN
    // erhöhtes Material-Band (statt zweier gestapelter gerahmter Kästen). Die
    // inneren Sections sind entrahmt; das Band trägt Rahmen/Schatten/Tönung.
    // Fehlt das Cockpit (alle Domänen als Widgets sichtbar → kein Glance-Inhalt),
    // kollabiert das Band per --slim auf eine schlanke Gruß-Leiste statt ein
    // großes leeres Rechteck zu zeigen (Critique R3 P1).
    const cockpitHtml = renderTodayCockpit(data, cfg);
    const mastheadSlim = cockpitHtml ? '' : ' dashboard-masthead--slim';
    setHtml(shell, `
      <section class="dashboard-masthead dashboard-masthead--${greetingPeriod()}${mastheadSlim}">
        ${renderDashboardOverview(user, isCustomizing)}
        ${cockpitHtml}
      </section>
      ${renderDashboardLayout(cfg, data, weather, currency, { editing: isCustomizing, visibleMealTypes })}
    `);
    wireLinks(container, rerender, { editing: isCustomizing });
    // Retry einer isolierten Widget-Fehlerkachel: da /dashboard aggregiert lädt,
    // ist „erneut versuchen" ein voller Neuaufbau (wie der Page-Level-Retry).
    container.querySelectorAll('[data-widget-retry]').forEach((btn) =>
      btn.addEventListener('click', rerender, { signal: _fabController.signal }));
    if (window.lucide) window.lucide.createIcons({ el: shell });
    wireWeatherRefresh(container, (updatedWeather) => {
      weather = updatedWeather;
      rebuildDashboard(cfg);
    });
    container.querySelector('#dashboard-customize-btn')?.addEventListener('click', () => {
      isCustomizing = !isCustomizing;
      if (!isCustomizing) {
        cancelDashboardConfig();
        return;
      }
      rebuildDashboard(widgetConfig);
    }, { signal: _fabController.signal });
    container.querySelector('#dashboard-customize-save')?.addEventListener('click', saveDashboardConfig, { signal: _fabController.signal });
    container.querySelector('#dashboard-customize-cancel')?.addEventListener('click', cancelDashboardConfig, { signal: _fabController.signal });
    container.querySelector('#dashboard-customize-reset')?.addEventListener('click', resetDashboardConfig, { signal: _fabController.signal });
    wireDashboardEditMode();
  }

  rebuildDashboard(widgetConfig);

  if (loadFailed) {
    // Kein FAB im Fehler-Zustand: seine Schnellaktionen würden in Module
    // navigieren, deren Daten gerade nicht geladen werden konnten — das würde
    // dem Fehler-Banner widersprechen. Retry stellt bei Erfolg alles her.
    container.querySelector('#fab-container')?.remove();
    container.querySelector('#fab-backdrop')?.remove();
  } else {
    initFab(container, _fabController.signal);
    wireFabAutoHide(container, _fabController.signal);
  }

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) return;
    const titleEl = container.querySelector('.dashboard-overview__title');
    if (titleEl) {
      titleEl.replaceChildren();
      titleEl.insertAdjacentHTML('afterbegin', greeting(user.display_name));
      // Gradient-Periode mit-resyncen: sonst aktualisieren sich über Mittag/18 Uhr
      // die Worte, aber der Tageszeit-Gradient bliebe auf dem alten Fenster stehen.
      titleEl.classList.remove(
        'dashboard-overview__title--morning',
        'dashboard-overview__title--day',
        'dashboard-overview__title--evening',
      );
      titleEl.classList.add(`dashboard-overview__title--${greetingPeriod()}`);
    }
    const dateEl  = container.querySelector('.dashboard-overview__date');
    if (dateEl)  dateEl.textContent = formatDate(new Date());
  }, { signal: _fabController.signal });

  // 30-Minuten Auto-Refresh für Wetter (inkl. optionaler Standort-Aktualisierung)
  const refreshBtn = container.querySelector('#weather-refresh-btn');
  if (refreshBtn) {
    const doAutoRefresh = async () => {
      try {
        await maybeUpdateAutoLocation({
          autoLocateEnabled: weatherAutoLocate,
          geolocation: navigator.geolocation,
          putPreferences: (body) => api.put('/preferences', body),
        });
        const res = await api.get(`/weather?lang=${encodeURIComponent(getLocale())}`).catch(() => ({ data: null }));
        weather = res.data ?? null;
        rebuildDashboard(widgetConfig);
      } catch { /* Hintergrund-Timer: bewusst still — der Nutzer hat nichts
                   angestoßen, ein Toast alle 30 Min wäre reiner Lärm. */ }
    };
    const timerId = setInterval(doAutoRefresh, 30 * 60 * 1000);
    _fabController.signal.addEventListener('abort', () => clearInterval(timerId));
    if (weatherAutoLocate) doAutoRefresh();
  }

  if (!localStorage.getItem(ONBOARDING_KEY)) {
    setTimeout(() => showOnboarding(container, () => maybeHintCustomize(container)), 400);
  } else {
    maybeHintCustomize(container);
  }
}

export const __test = {
  buildTodayHighlights,
  normalizeVisibleMealTypes,
  renderTodayMeals,
  calendarEventRoute,
  eventOccurrenceDateKey,
  normalizeDashboardConfig,
  WIDGET_SIZE_PRESETS,
};

function wireWeatherRefresh(container, onUpdated = null) {
  const refreshBtn = container.querySelector('#weather-refresh-btn');
  if (!refreshBtn) return;
  const doWeatherRefresh = async () => {
    refreshBtn.disabled = true;
    refreshBtn.classList.add('weather-widget__refresh--spinning');
    try {
      const res = await api.get(`/weather?lang=${encodeURIComponent(getLocale())}`).catch(() => ({ data: null }));
      // Manuelle Aktion: ein Fehlschlag darf nicht still als Erfolg quittiert
      // werden (sonst wirkt der Button tot). Kein Datensatz → Fehler-Toast.
      if (!res.data) {
        window.yuvomi?.showToast(t('common.errorGeneric'), 'error');
        return;
      }
      const wWidget = container.querySelector('#weather-widget');
      if (wWidget) {
        const wrapper = wWidget.closest('.widget-wrapper');
        if (wrapper) {
          wrapper.querySelector('.widget')?.remove();
          wrapper.insertAdjacentHTML('beforeend', renderWeatherWidget(res.data));
        }
        const newWidget = container.querySelector('#weather-widget');
        if (newWidget && window.lucide) window.lucide.createIcons({ el: newWidget });
        onUpdated?.(res.data);
        window.yuvomi?.showToast(t('dashboard.weatherUpdated'), 'success', 1500);
      }
    } catch {
      window.yuvomi?.showToast(t('common.errorGeneric'), 'error');
    } finally {
      // Immer aufräumen, damit der Button nach jedem Ausgang wieder bedienbar
      // ist (bei Erfolg wird das Widget ohnehin frisch gerendert).
      refreshBtn.disabled = false;
      refreshBtn.classList.remove('weather-widget__refresh--spinning');
    }
  };
  refreshBtn.addEventListener('click', doWeatherRefresh, { signal: _fabController.signal });
}

// Scroll-bewusstes Ausblenden des FAB: beim Runterscrollen weicht der schwebende
// FAB nach unten aus, damit er die „Alle"-Header-Links der Widgets nicht überdeckt
// und ihre Klicks nicht abfängt (Critique P2, per Hit-Test belegt); beim Hochscrollen
// (Handlungsabsicht) und nahe dem oberen Rand kommt er zurück. Offen (Speed-Dial
// ausgeklappt) wird nie versteckt. `passive` + rAF halten das Scrollen flüssig.
function wireFabAutoHide(container, signal) {
  const scroller = container.closest('.app-content') || document.querySelector('.app-content');
  const fab = container.querySelector('#fab-container');
  if (!scroller || !fab) return;
  let lastY = scroller.scrollTop;
  let ticking = false;
  scroller.addEventListener('scroll', () => {
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(() => {
      const y = scroller.scrollTop;
      const isOpen = fab.querySelector('.fab-main')?.classList.contains('fab-main--open');
      if (!isOpen) {
        if (y < 24 || y < lastY - 4) fab.classList.remove('fab-container--hidden');
        else if (y > lastY + 4) fab.classList.add('fab-container--hidden');
      }
      lastY = y;
      ticking = false;
    });
  }, { passive: true, signal });
}
