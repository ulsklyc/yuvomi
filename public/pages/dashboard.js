/**
 * Modul: Dashboard
 * Zweck: Startseite mit Begrüßung, Terminen, Aufgaben, Essen, Notizen und FAB
 * Abhängigkeiten: /api.js
 */

import { api } from '/api.js';
import { t, formatDate, formatTime, getLocale } from '/i18n.js';
import { esc, fmtLocation, renderMarkdownLight } from '/utils/html.js';
import { openModal, closeModal } from '/components/modal.js';
import { renderAvatarStack } from '/components/user-multi-select.js';

// Hält den AbortController des aktuellen FAB-Listeners - wird bei jedem render() erneuert.
let _fabController = null;

// ── Onboarding ──────────────────────────────────────────────────────────────

const ONBOARDING_KEY = 'oikos-onboarded';
const APP_NAME_STORAGE_KEY = 'oikos-app-name';

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

function showOnboarding(appContainer) {
  const steps = getOnboardingSteps();
  let current = 0;

  const overlay = document.createElement('div');
  overlay.className = 'onboarding-overlay';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');

  const closeOnEscape = (event) => {
    if (event.key === 'Escape') finish();
  };
  document.addEventListener('keydown', closeOnEscape);

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

  function finish() {
    document.removeEventListener('keydown', closeOnEscape);
    localStorage.setItem(ONBOARDING_KEY, '1');
    overlay.classList.add('onboarding-overlay--out');
    overlay.addEventListener('animationend', () => overlay.remove(), { once: true });
    // Fallback falls animationend nicht feuert (prefers-reduced-motion):
    setTimeout(() => overlay.remove(), 300);
  }

  renderStep();
  appContainer.appendChild(overlay);
}

// --------------------------------------------------------
// Widget-Definitionen (Reihenfolge = Standard-Layout)
// --------------------------------------------------------

// NEU — primäre Inhalte (tasks, calendar) ganz oben
const WIDGET_IDS = ['tasks', 'calendar', 'weather', 'meals', 'shopping', 'birthdays', 'budget', 'family', 'notes'];

const WIDGET_SIZE_PRESETS = [
  { value: '1x1', labelKey: 'dashboard.widgetSizeTiny'     },
  { value: '2x1', labelKey: 'dashboard.widgetSizeNarrow'   },
  { value: '2x2', labelKey: 'dashboard.widgetSizeStandard' },
  { value: '3x2', labelKey: 'dashboard.widgetSizeLarge'    },
  { value: '4x2', labelKey: 'dashboard.widgetSizeFull'     },
];

// Alle bekannten Größen inkl. Legacy-Werte — für normalizeDashboardConfig-Validierung
const WIDGET_SIZE_OPTIONS = [...new Set([
  ...WIDGET_SIZE_PRESETS.map((p) => p.value),
  '1x2', '1x3', '1x4', '2x3', '2x4', '3x1', '3x3', '3x4', '4x1', '4x3', '4x4',
])];

function widgetSizeLabel(size) {
  const preset = WIDGET_SIZE_PRESETS.find((p) => p.value === size);
  return preset ? t(preset.labelKey) : size;
}

function defaultWidgetSize(id) {
  if (['tasks', 'calendar'].includes(id)) return '2x2';
  if (['weather', 'shopping'].includes(id)) return '2x1';
  if (id === 'notes') return '2x1';
  return '1x1';
}

const DEFAULT_WIDGET_CONFIG = WIDGET_IDS.map((id, i) => ({ id, visible: true, order: i, size: defaultWidgetSize(id) }));

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
      valid.push({ id, visible: true, order: valid.length, size: defaultWidgetSize(id) });
    }
  }
  return valid
    .sort((a, b) => a.order - b.order)
    .map((w, i) => ({ ...w, order: i }));
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
    family:   () => t('dashboard.familyMembers'),
  };
  return (map[id] ?? (() => id))();
}

function widgetIcon(id) {
  const map = { tasks: 'check-square', calendar: 'calendar', birthdays: 'cake', budget: 'wallet', family: 'users', shopping: 'shopping-cart', meals: 'utensils', notes: 'pin', weather: 'cloud-sun' };
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
  if (h < 12) return t('dashboard.greetingMorning', { name: esc(displayName) });
  if (h < 18) return t('dashboard.greetingDay',     { name: esc(displayName) });
  return t('dashboard.greetingEvening', { name: esc(displayName) });
}

function formatDateTime(isoString) {
  if (!isoString) return '';
  const d = new Date(isoString);
  const today = new Date();
  const tomorrow = new Date(today);
  tomorrow.setDate(today.getDate() + 1);

  const dateStr = d.toDateString() === today.toDateString()
    ? t('common.today')
    : d.toDateString() === tomorrow.toDateString()
    ? t('common.tomorrow')
    : formatDate(d);

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
  const nextEvent = events[0] ?? null;
  const openShoppingCount = shoppingItems.length
    ? shoppingItems.filter((item) => !item.is_checked).length
    : shoppingLists.reduce((sum, list) => {
        if (Number.isFinite(Number(list.open_count))) return sum + Number(list.open_count);
        if (Number.isFinite(Number(list.openCount))) return sum + Number(list.openCount);
        const items = Array.isArray(list.items) ? list.items : [];
        return sum + items.filter((item) => !item.is_checked).length;
      }, 0);
  const dinner = Array.isArray(meals)
    ? meals.find((meal) => meal.meal_type === 'dinner') ?? null
    : meals?.dinner ?? null;

  return {
    urgentTask,
    nextEvent,
    openShoppingCount,
    dinner,
  };
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
      <div class="event-item" data-route="/calendar" role="button" tabindex="0">
        <div class="event-item__bar" style="background-color:${esc(e.color || e.cal_color) || 'var(--color-accent)'}"></div>
        <div class="event-item__content">
          <div class="event-item__title">${esc(e.title)}</div>
          <div class="event-item__time">
            <span class="event-time-badge ${isToday ? 'event-time-badge--today' : ''}">${isToday ? t('common.today') : formatDateTime(e.start_datetime).split(',')[0]}</span>
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

function renderTodayMeals(meals) {
  const MEAL_ORDER = ['breakfast', 'lunch', 'dinner', 'snack'];

  const mealLabels = MEAL_LABELS();
  const slots = MEAL_ORDER.map((type) => {
    const meal = meals.find((m) => m.meal_type === type);
    return `
      <div class="meal-slot ${meal ? 'meal-slot--filled' : ''}" data-type="${type}" data-route="/meals" role="button" tabindex="0">
        <i data-lucide="${MEAL_ICONS[type]}" class="meal-slot__icon" aria-hidden="true"></i>
        <div class="meal-slot__type">${mealLabels[type]}</div>
        <div class="meal-slot__title">${meal ? esc(meal.title) : '-'}</div>
      </div>
    `;
  }).join('');

  return `<div class="widget widget--meals">
    ${widgetHeader('utensils', t('dashboard.todayMeals'), null, '/meals', t('dashboard.weekLink'))}
    <div class="meal-slots">${slots}</div>
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

  return `<div class="widget widget--notes widget--wide">
    ${widgetHeader('pin', t('nav.notes'), notes.length, '/notes')}
    <div class="notes-grid-widget">${items}</div>
  </div>`;
}

function renderFamilyWidget(users) {
  const visible = users.slice(0, 6);
  const avatars = visible.map((u) => `
    <span class="family-widget-avatar" style="background:${esc(u.avatar_color || '#64748b')}" title="${esc(u.display_name)}">
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

  return `<div class="widget widget--budget">
    ${widgetHeader('wallet', t('dashboard.budgetOverview'), null, '/budget')}
    <div class="budget-widget">
      <div class="budget-widget__headline">
        <span>${t('dashboard.monthlyBalance')}</span>
        <strong class="budget-widget__balance budget-widget__balance--${balanceTone}">${formatCurrency(balance, currency)}</strong>
      </div>
      <div class="budget-widget__grid">
        <div class="budget-widget-metric budget-widget-metric--income">
          <span>${t('dashboard.monthlyIncome')}</span>
          <strong>${formatCurrency(income, currency)}</strong>
        </div>
        <div class="budget-widget-metric budget-widget-metric--expense">
          <span>${t('dashboard.monthlyExpenses')}</span>
          <strong>${formatCurrency(expenses, currency)}</strong>
        </div>
        <div class="budget-widget-metric">
          <span>${t('dashboard.savingsRate')}</span>
          <strong>${income > 0 ? `${savingsRate}%` : '-'}</strong>
        </div>
        <div class="budget-widget-metric">
          <span>${t('dashboard.budgetEntries')}</span>
          <strong>${budget?.entryCount || 0}</strong>
        </div>
      </div>
      <div class="budget-widget__footer">
        ${hasData && budget?.topExpenseCategory
          ? `${t('dashboard.topExpense')}: <strong>${esc(budgetCategoryLabel(budget.topExpenseCategory))}</strong> · ${formatCurrency(budget.topExpenseAmount, currency)}`
          : t('dashboard.noBudgetData')}
      </div>
    </div>
  </div>`;
}

function renderQuickAction({ route, label, icon, tone = '' }) {
  return `
    <button type="button" class="dashboard-action ${tone ? `dashboard-action--${tone}` : ''}" data-route="${route}" aria-label="${esc(label)}">
      <span class="dashboard-action__icon"><i data-lucide="${icon}" aria-hidden="true"></i></span>
      <span class="dashboard-action__label">${label}</span>
    </button>
  `;
}

function renderTodayCard(icon, label, value, route, tone) {
  return `
    <button type="button" class="today-cockpit-card today-cockpit-card--${tone}" data-route="${route}">
      <span class="today-cockpit-card__icon"><i data-lucide="${icon}" aria-hidden="true"></i></span>
      <span class="today-cockpit-card__label">${esc(label)}</span>
      <strong class="today-cockpit-card__value">${esc(value)}</strong>
    </button>
  `;
}

function renderTodayCockpit(data) {
  const highlights = buildTodayHighlights(data);
  const taskTitle = highlights.urgentTask?.title ?? t('dashboard.todayNoTasks');
  const eventTitle = highlights.nextEvent?.title ?? t('dashboard.todayNoEvents');
  const dinnerTitle = highlights.dinner?.title ?? t('dashboard.todayNoDinner');

  return `
    <section class="today-cockpit" aria-labelledby="today-cockpit-title">
      <div class="today-cockpit__header">
        <h2 id="today-cockpit-title">${esc(t('dashboard.todayTitle'))}</h2>
        <span class="today-cockpit__date">${esc(formatDate(new Date()))}</span>
      </div>
      <div class="today-cockpit__grid">
        ${!window.oikos?.isModuleDisabled('tasks')    ? renderTodayCard('check-square',   t('dashboard.todayTask'),     taskTitle, '/tasks', 'task') : ''}
        ${!window.oikos?.isModuleDisabled('calendar') ? renderTodayCard('calendar',        t('dashboard.todayEvent'),    eventTitle, '/calendar', 'event') : ''}
        ${!window.oikos?.isModuleDisabled('shopping') ? renderTodayCard('shopping-cart',   t('dashboard.todayShopping'), t('dashboard.todayShoppingCount', { count: highlights.openShoppingCount }), '/shopping', 'shopping') : ''}
        ${!window.oikos?.isModuleDisabled('meals')    ? renderTodayCard('utensils',        t('dashboard.todayDinner'),   dinnerTitle, '/meals', 'dinner') : ''}
      </div>
    </section>
  `;
}


function renderDashboardOverview(user, editing = false) {
  const dateLabel = formatDate(new Date());

  const actions = [
    { route: '/tasks', label: t('nav.tasks'), icon: 'check-square', tone: 'blue' },
    { route: '/calendar', label: t('nav.calendar'), icon: 'calendar', tone: 'violet' },
    { route: '/shopping', label: t('nav.shopping'), icon: 'shopping-cart', tone: 'green' },
    { route: '/notes', label: t('nav.notes'), icon: 'sticky-note', tone: 'amber' },
  ].map(renderQuickAction).join('');

  return `
    <section class="dashboard-overview">
      <div class="dashboard-overview__header">
        <div class="dashboard-overview__heading">
          <span class="dashboard-overview__date">${dateLabel}</span>
          <h1 class="dashboard-overview__title">${greeting(user.display_name)}</h1>
        </div>
        <div class="dashboard-overview__tools">
          ${editing ? `
          <div class="dashboard-customize-toolbar" role="toolbar" aria-label="${t('dashboard.customizeTitle')}">
            <button class="btn btn--secondary" id="dashboard-manage-widgets">
              <i data-lucide="sliders-horizontal" aria-hidden="true"></i>
              ${t('dashboard.customizeManage')}
            </button>
            <button class="btn btn--ghost" id="dashboard-customize-reset">${t('dashboard.customizeReset')}</button>
            <button class="btn btn--secondary" id="dashboard-customize-cancel">${t('common.cancel')}</button>
            <button class="btn btn--primary" id="dashboard-customize-save">${t('common.save')}</button>
          </div>` : `<div class="dashboard-overview__actions">${actions}</div>`}
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

function renderWidgetCustomizeControls(w) {
  const sizeOptions = WIDGET_SIZE_PRESETS.map(({ value: size }) => `
    <option value="${size}" ${w.size === size ? 'selected' : ''}>${widgetSizeLabel(size)}</option>
  `).join('');

  return `
    <div class="widget-edit-controls" data-widget-controls>
      <button type="button" class="widget-edit-controls__handle" data-widget-drag-handle aria-label="${t('dashboard.customizeDrag')}">
        <i data-lucide="grip-vertical" aria-hidden="true"></i>
      </button>
      <label class="widget-edit-controls__size">
        <span>${t('dashboard.customizeSize')}</span>
        ${renderSizeMiniGrid(w.size)}
        <select class="widget-edit-controls__select" data-widget-size="${esc(w.id)}" aria-label="${t('dashboard.customizeSizeFor', { widget: widgetLabel(w.id) })}">
          ${sizeOptions}
        </select>
      </label>
      <button type="button" class="widget-edit-controls__hide" data-widget-hide="${esc(w.id)}" aria-label="${t('dashboard.customizeHide', { widget: widgetLabel(w.id) })}">
        <i data-lucide="eye-off" aria-hidden="true"></i>
      </button>
    </div>
  `;
}

function renderDashboardLayout(cfg, data, weather, currency, { editing = false } = {}) {
  const widgetById = {
    tasks: () => renderUrgentTasks(data.urgentTasks ?? []),
    calendar: () => renderUpcomingEvents(data.upcomingEvents ?? []),
    birthdays: () => renderUpcomingBirthdays(data.birthdays ?? []),
    budget: () => renderBudgetWidget(data.budget ?? {}, currency),
    family: () => renderFamilyWidget(data.users ?? []),
    meals: () => renderTodayMeals(data.todayMeals ?? []),
    notes: () => renderPinnedNotes(data.pinnedNotes ?? []),
    shopping: () => renderShoppingLists(data.shoppingLists ?? []),
    weather: () => (weather ? renderWeatherWidget(weather) : ''),
  };

  const MODULE_FOR_WIDGET = { tasks: 'tasks', calendar: 'calendar', shopping: 'shopping', meals: 'meals', notes: 'notes', birthdays: 'birthdays', budget: 'budget' };
  const tiles = cfg
    .filter((w) => {
      if (!w.visible || !widgetById[w.id]) return false;
      const mod = MODULE_FOR_WIDGET[w.id];
      return !mod || !window.oikos?.isModuleDisabled(mod);
    })
    .map((w) => {
      const html = widgetById[w.id]();
      if (!html) return '';
      return `<div class="widget-wrapper ${widgetSizeClass(w.size)} ${editing ? 'widget-wrapper--editing' : ''}"
                   data-widget-id="${esc(w.id)}" ${editing ? 'draggable="true"' : ''}>
        ${editing ? renderWidgetCustomizeControls(w) : ''}
        ${html}
      </div>`;
    })
    .join('');

  return `<div class="dashboard__grid ${editing ? 'dashboard__grid--editing' : ''}" id="dashboard-widget-grid">${tiles}</div>`;
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

// --------------------------------------------------------
// Shopping-Widget
// --------------------------------------------------------

function renderShoppingLists(lists) {
  if (!lists.length) return '';

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
          <div class="shopping-widget-list__bar" style="width:${progress}%"></div>
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
    <div class="fab-action" data-route="${a.route}" role="button" tabindex="-1"
         aria-label="${a.label}">
      <span class="fab-action__label">${a.label}</span>
      <button class="fab-action__btn" tabindex="-1" aria-hidden="true">
        <i data-lucide="${a.icon}" aria-hidden="true"></i>
      </button>
    </div>
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
    fabActions.querySelectorAll('[role="button"]').forEach((el) => {
      el.tabIndex = open ? 0 : -1;
    });
    if (window.lucide) window.lucide.createIcons({ el: container });
  }

  fabMain.addEventListener('click', (e) => { e.stopPropagation(); toggleFab(); });

  fabActions.querySelectorAll('[data-route]').forEach((el) => {
    const go = async () => {
      toggleFab(false);
      await window.oikos.navigate(el.dataset.route);
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
// Customize-Modal
// --------------------------------------------------------

function openCustomizeModal(currentConfig, onSave) {
  let draft = currentConfig.map((w) => ({ ...w }));

  function buildRows() {
    return draft.map((w, i) => {
      const isFirst = i === 0;
      const isLast  = i === draft.length - 1;
      const sizeOptions = WIDGET_SIZE_OPTIONS.map((size) => `
        <option value="${size}" ${w.size === size ? 'selected' : ''}>${widgetSizeLabel(size)}</option>
      `).join('');
      return `
        <div class="customize-row" data-id="${esc(w.id)}" style="view-transition-name: widget-row-${esc(w.id)}">
          <label class="customize-row__toggle">
            <input type="checkbox" class="customize-row__check" data-id="${w.id}"
                   ${w.visible ? 'checked' : ''} aria-label="${widgetLabel(w.id)}">
            <span class="customize-row__slider" aria-hidden="true"></span>
          </label>
          <i data-lucide="${widgetIcon(w.id)}" class="customize-row__icon" aria-hidden="true"></i>
          <span class="customize-row__name">${widgetLabel(w.id)}</span>
          <label class="customize-row__size">
            <span>${t('dashboard.customizeSize')}</span>
            ${renderSizeMiniGrid(w.size)}
            <select class="form-input customize-row__select" data-size-id="${esc(w.id)}" aria-label="${t('dashboard.customizeSizeFor', { widget: widgetLabel(w.id) })}">
              ${sizeOptions}
            </select>
          </label>
          <div class="customize-row__actions">
            <button class="customize-row__btn" data-move="up" data-id="${w.id}"
                    ${isFirst ? 'disabled' : ''} aria-label="${t('dashboard.customizeMoveUp')}">
              <i data-lucide="chevron-up" class="icon-md" aria-hidden="true"></i>
            </button>
            <button class="customize-row__btn" data-move="down" data-id="${w.id}"
                    ${isLast ? 'disabled' : ''} aria-label="${t('dashboard.customizeMoveDown')}">
              <i data-lucide="chevron-down" class="icon-md" aria-hidden="true"></i>
            </button>
          </div>
        </div>
      `;
    }).join('');
  }

  openModal({
    title:  t('dashboard.customizeTitle'),
    size:   'sm',
    content: `
      <div class="customize-list" id="customize-list">${buildRows()}</div>
      <div class="modal-actions" style="margin-top:var(--space-4)">
        <button type="button" class="btn btn--ghost" id="customize-reset">${t('dashboard.customizeReset')}</button>
        <button type="button" class="btn btn--primary" id="customize-save">${t('common.save')}</button>
      </div>`,
    onSave(panel) {
      if (window.lucide) window.lucide.createIcons({ el: panel });

      function rebuildList() {
        const list = panel.querySelector('#customize-list');
        if (!list) return;
        const doRebuild = () => {
          list.replaceChildren();
          list.insertAdjacentHTML('beforeend', buildRows());
          if (window.lucide) window.lucide.createIcons({ el: list });
          wireRows();
        };
        const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        if (document.startViewTransition && !reducedMotion) {
          document.startViewTransition(doRebuild);
        } else {
          doRebuild();
        }
      }

      function wireRows() {
        const list = panel.querySelector('#customize-list');
        if (!list) return;

        list.querySelectorAll('.customize-row__check').forEach((cb) => {
          cb.addEventListener('change', () => {
            const id = cb.dataset.id;
            const entry = draft.find((w) => w.id === id);
            if (entry) entry.visible = cb.checked;
          });
        });

        list.querySelectorAll('[data-move]').forEach((btn) => {
          btn.addEventListener('click', () => {
            const id  = btn.dataset.id;
            const dir = btn.dataset.move;
            const idx = draft.findIndex((w) => w.id === id);
            if (dir === 'up' && idx > 0) {
              [draft[idx - 1], draft[idx]] = [draft[idx], draft[idx - 1]];
            } else if (dir === 'down' && idx < draft.length - 1) {
              [draft[idx], draft[idx + 1]] = [draft[idx + 1], draft[idx]];
            }
            draft.forEach((w, i) => { w.order = i; });
            rebuildList();
          });
        });

        list.querySelectorAll('[data-size-id]').forEach((select) => {
          select.addEventListener('change', () => {
            const entry = draft.find((w) => w.id === select.dataset.sizeId);
            if (!entry || !WIDGET_SIZE_OPTIONS.includes(select.value)) return;
            entry.size = select.value;
            const mini = select.closest('.customize-row__size')?.querySelector('.widget-size-mini');
            if (mini) {
              mini.replaceChildren();
              mini.insertAdjacentHTML('afterbegin', renderSizeMiniGridCells(select.value));
            }
          });
        });

        list.querySelectorAll('.customize-row').forEach((row, idx) => {
          row.setAttribute('draggable', 'true');
          row.addEventListener('dragstart', (e) => {
            e.dataTransfer.effectAllowed = 'move';
            e.dataTransfer.setData('text/plain', String(idx));
            row.classList.add('customize-row--dragging');
          });
          row.addEventListener('dragend', () => row.classList.remove('customize-row--dragging'));
          row.addEventListener('dragover', (e) => {
            e.preventDefault();
            e.dataTransfer.dropEffect = 'move';
            row.classList.add('customize-row--over');
          });
          row.addEventListener('dragleave', () => row.classList.remove('customize-row--over'));
          row.addEventListener('drop', (e) => {
            e.preventDefault();
            row.classList.remove('customize-row--over');
            const fromIdx = parseInt(e.dataTransfer.getData('text/plain'), 10);
            if (fromIdx === idx) return;
            const [moved] = draft.splice(fromIdx, 1);
            draft.splice(idx, 0, moved);
            draft.forEach((w, i) => { w.order = i; });
            rebuildList();
          });
        });
      }

      wireRows();

      panel.querySelector('#customize-reset')?.addEventListener('click', () => {
        draft = DEFAULT_WIDGET_CONFIG.map((w) => ({ ...w }));
        rebuildList();
      });

      panel.querySelector('#customize-save')?.addEventListener('click', async () => {
        const saveBtn = panel.querySelector('#customize-save');
        saveBtn.disabled = true;
        try {
          await api.put('/preferences', { dashboard_widgets: draft });
          closeModal({ force: true });
          onSave(draft);
          window.oikos?.showToast(t('dashboard.customizeSaved'), 'success', 1500);
        } catch {
          window.oikos?.showToast(t('common.errorGeneric'), 'error');
        } finally {
          saveBtn.disabled = false;
        }
      });
    },
  });
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
          window.oikos?.showToast(t('tasks.swipedDoneToast'), 'success');
          rerender();
        } catch (err) {
          window.oikos?.showToast(err.message, 'danger');
        }
      });
      panel.querySelector('[data-action="edit"]').addEventListener('click', () => {
        closeModal({ force: true });
        window.oikos.navigate(`/tasks?open=${taskId}`);
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
    const go = () => window.oikos.navigate(el.dataset.route);
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

  let data         = { upcomingEvents: [], urgentTasks: [], todayMeals: [], pinnedNotes: [], shoppingLists: [], birthdays: [], users: [], budget: {} };
  let weather      = null;
  let widgetConfig = DEFAULT_WIDGET_CONFIG;
  let savedWidgetConfig = DEFAULT_WIDGET_CONFIG;
  let isCustomizing = false;
  let currency     = 'EUR';
  try {
    const [dashRes, weatherRes, prefsRes] = await Promise.all([
      api.get('/dashboard'),
      api.get(`/weather?lang=${encodeURIComponent(getLocale())}`).catch(() => ({ data: null })),
      api.get('/preferences').catch(() => ({ data: {} })),
    ]);
    data         = dashRes;
    weather      = weatherRes.data ?? null;
    widgetConfig = normalizeDashboardConfig(prefsRes.data?.dashboard_widgets ?? DEFAULT_WIDGET_CONFIG);
    savedWidgetConfig = widgetConfig.map((w) => ({ ...w }));
    currency     = prefsRes.data?.currency ?? 'EUR';
  } catch (err) {
    console.error('[Dashboard] Ladefehler:', err.message, 'Status:', err.status ?? 'network');
    window.oikos?.showToast(t('dashboard.loadError'), 'warning');
  }

  const rerender = () => render(container, { user });

  async function saveDashboardConfig() {
    try {
      await api.put('/preferences', { dashboard_widgets: widgetConfig });
      savedWidgetConfig = widgetConfig.map((w) => ({ ...w }));
      isCustomizing = false;
      rebuildDashboard(widgetConfig);
      window.oikos?.showToast(t('dashboard.customizeSaved'), 'success', 1500);
    } catch {
      window.oikos?.showToast(t('common.errorGeneric'), 'error');
    }
  }

  function cancelDashboardConfig() {
    widgetConfig = savedWidgetConfig.map((w) => ({ ...w }));
    isCustomizing = false;
    rebuildDashboard(widgetConfig);
  }

  function resetDashboardConfig() {
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

    grid.querySelectorAll('[data-widget-size]').forEach((select) => {
      select.addEventListener('change', () => {
        if (!WIDGET_SIZE_OPTIONS.includes(select.value)) return;
        widgetConfig = updateWidgetConfig(widgetConfig, select.dataset.widgetSize, { size: select.value });
        rebuildDashboard(widgetConfig);
      });
    });

    grid.querySelectorAll('[data-widget-hide]').forEach((btn) => {
      btn.addEventListener('click', () => {
        widgetConfig = updateWidgetConfig(widgetConfig, btn.dataset.widgetHide, { visible: false });
        rebuildDashboard(widgetConfig);
      });
    });
  }

  function rebuildDashboard(cfg) {
    const shell = container.querySelector('#dashboard-shell');
    if (!shell) return;
    setHtml(shell, `
      ${renderDashboardOverview(user, isCustomizing)}
      ${renderTodayCockpit(data)}
      ${renderDashboardLayout(cfg, data, weather, currency, { editing: isCustomizing })}
    `);
    wireLinks(container, rerender, { editing: isCustomizing });
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
    container.querySelector('#dashboard-manage-widgets')?.addEventListener('click', () => {
      openCustomizeModal(widgetConfig, (newConfig) => {
        widgetConfig = normalizeDashboardConfig(newConfig);
        savedWidgetConfig = widgetConfig.map((w) => ({ ...w }));
        isCustomizing = false;
        rebuildDashboard(widgetConfig);
      });
    }, { signal: _fabController.signal });
    container.querySelector('#dashboard-customize-save')?.addEventListener('click', saveDashboardConfig, { signal: _fabController.signal });
    container.querySelector('#dashboard-customize-cancel')?.addEventListener('click', cancelDashboardConfig, { signal: _fabController.signal });
    container.querySelector('#dashboard-customize-reset')?.addEventListener('click', resetDashboardConfig, { signal: _fabController.signal });
    wireDashboardEditMode();
  }

  rebuildDashboard(widgetConfig);

  initFab(container, _fabController.signal);

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) return;
    const titleEl = container.querySelector('.dashboard-overview__title');
    if (titleEl) {
      titleEl.replaceChildren();
      titleEl.insertAdjacentHTML('afterbegin', greeting(user.display_name));
    }
    const dateEl  = container.querySelector('.dashboard-overview__date');
    if (dateEl)  dateEl.textContent = formatDate(new Date());
  }, { signal: _fabController.signal });

  // 30-Minuten Auto-Refresh für Wetter
  const refreshBtn = container.querySelector('#weather-refresh-btn');
  if (refreshBtn) {
    const doAutoRefresh = async () => {
      try {
        const res = await api.get(`/weather?lang=${encodeURIComponent(getLocale())}`).catch(() => ({ data: null }));
        weather = res.data ?? null;
        rebuildDashboard(widgetConfig);
      } catch { /* silently ignore */ }
    };
    const timerId = setInterval(doAutoRefresh, 30 * 60 * 1000);
    _fabController.signal.addEventListener('abort', () => clearInterval(timerId));
  }

  if (!localStorage.getItem(ONBOARDING_KEY)) {
    setTimeout(() => showOnboarding(container), 400);
  }
}

export const __test = { buildTodayHighlights };

function wireWeatherRefresh(container, onUpdated = null) {
  const refreshBtn = container.querySelector('#weather-refresh-btn');
  if (!refreshBtn) return;
  const doWeatherRefresh = async () => {
    refreshBtn.disabled = true;
    refreshBtn.classList.add('weather-widget__refresh--spinning');
    try {
      const res = await api.get(`/weather?lang=${encodeURIComponent(getLocale())}`).catch(() => ({ data: null }));
      const wWidget = container.querySelector('#weather-widget');
      if (wWidget) {
        const wrapper = wWidget.closest('.widget-wrapper');
        if (wrapper) {
          wrapper.querySelector('.widget')?.remove();
          wrapper.insertAdjacentHTML('beforeend', renderWeatherWidget(res.data ?? null));
        }
        const newWidget = container.querySelector('#weather-widget');
        if (newWidget && window.lucide) window.lucide.createIcons({ el: newWidget });
        onUpdated?.(res.data ?? null);
        window.oikos?.showToast(t('dashboard.weatherUpdated'), 'success', 1500);
      }
    } catch { /* silently ignore */ }
  };
  refreshBtn.addEventListener('click', doWeatherRefresh, { signal: _fabController.signal });
}
