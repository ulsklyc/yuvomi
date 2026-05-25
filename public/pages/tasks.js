/**
 * Modul: Aufgaben (Tasks)
 * Zweck: Listenansicht mit Filtern, Gruppierung, CRUD-Modal, Subtask-Verwaltung
 * Abhängigkeiten: /api.js
 */

import { api } from '/api.js';
import { renderRRuleFields, bindRRuleEvents, getRRuleValues } from '/rrule-ui.js';
import { openModal as openSharedModal, closeModal, wireBlurValidation, validateAll, btnSuccess, btnError, promptModal } from '/components/modal.js';
import { stagger, vibrate } from '/utils/ux.js';
import { t, formatDate, formatTime, dateInputPlaceholder, formatDateInput, parseDateInput, isDateInputValid, formatTimeInput, parseTimeInput, timeInputPlaceholder } from '/i18n.js';
import { esc } from '/utils/html.js';
import { refresh as refreshReminders } from '/reminders.js';
import { renderUserMultiSelect, getSelectedUserIds, bindUserMultiSelect, renderAvatarStack } from '/components/user-multi-select.js';

// --------------------------------------------------------
// Konstanten
// --------------------------------------------------------

const PRIORITIES = () => [
  { value: 'urgent', label: t('tasks.priorityUrgent'), color: 'var(--color-priority-urgent)' },
  { value: 'high',   label: t('tasks.priorityHigh'),   color: 'var(--color-priority-high)'   },
  { value: 'medium', label: t('tasks.priorityMedium'), color: 'var(--color-priority-medium)' },
  { value: 'low',    label: t('tasks.priorityLow'),    color: 'var(--color-priority-low)'    },
  { value: 'none',   label: t('tasks.priorityNone'),   color: 'var(--color-priority-none)'   },
];

const PRIO_ORDER = { urgent: 0, high: 1, medium: 2, low: 3, none: 4 };

const STATUSES = () => [
  { value: 'open',        label: t('tasks.statusOpen')       },
  { value: 'in_progress', label: t('tasks.statusInProgress') },
  { value: 'done',        label: t('tasks.statusDone')       },
  { value: 'archived',    label: t('tasks.statusArchived')   },
];

const CATEGORIES = [
  'household', 'school', 'shopping', 'repair',
  'health', 'finance', 'leisure', 'misc',
];

const CATEGORY_LABELS = () => ({
  'household': t('tasks.categoryHousehold'),
  'school':    t('tasks.categorySchool'),
  'shopping':  t('tasks.categoryShopping'),
  'repair':    t('tasks.categoryRepair'),
  'health':    t('tasks.categoryHealth'),
  'finance':   t('tasks.categoryFinance'),
  'leisure':   t('tasks.categoryLeisure'),
  'misc':      t('tasks.categoryMisc'),
});

const PRIORITY_LABELS = () => Object.fromEntries(PRIORITIES().map((p) => [p.value, p.label]));
const STATUS_LABELS   = () => Object.fromEntries(STATUSES().map((s)  => [s.value, s.label]));

// --------------------------------------------------------
// Hilfsfunktionen
// --------------------------------------------------------

function initials(name = '') {
  return name.split(' ').map((w) => w[0]).join('').slice(0, 2).toUpperCase();
}

function formatDueDate(dateStr, timeStr) {
  if (!dateStr) return null;
  const dueDate = timeStr ? new Date(`${dateStr}T${timeStr}`) : new Date(`${dateStr}T23:59:59`);
  if (isNaN(dueDate)) return null;

  const now    = new Date();
  const today  = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const dueDay = new Date(dueDate.getFullYear(), dueDate.getMonth(), dueDate.getDate());
  const calDayDiff = Math.round((dueDay - today) / (1000 * 60 * 60 * 24));

  const timeLabel = timeStr ? ` – ${formatTime(dueDate)}` : '';
  const fullLabel = timeStr ? `${formatDate(dueDate)}, ${formatTime(dueDate)}` : formatDate(dueDate);

  if (dueDate < now) {
    return { label: `${t('tasks.overdue')} – ${fullLabel}`, cls: 'due-date--overdue' };
  }
  if (calDayDiff === 0) {
    return { label: `${t('tasks.dueToday')}${timeLabel}`, cls: 'due-date--today' };
  }
  if (calDayDiff === 1) {
    return { label: `${t('tasks.dueTomorrow')}${timeLabel}`, cls: '' };
  }
  return { label: fullLabel, cls: '' };
}

function groupBy(tasks, mode) {
  const groups = {};

  if (mode === 'category') {
    for (const t of tasks) {
      const key = t.category || 'Sonstiges';
      (groups[key] = groups[key] || []).push(t);
    }
    return Object.entries(groups).sort(([a], [b]) => a.localeCompare(b, 'de'));
  }

  // mode === 'due'
  const groupOverdue  = t('tasks.groupOverdue');
  const groupToday    = t('tasks.groupToday');
  const groupThisWeek = t('tasks.groupThisWeek');
  const groupNextWeek = t('tasks.groupNextWeek');
  const groupLater    = t('tasks.groupLater');
  const groupNoDate   = t('tasks.groupNoDate');

  for (const task of tasks) {
    let key;
    if (!task.due_date)                  key = groupNoDate;
    else {
      const diff = Math.round((new Date(task.due_date) - new Date().setHours(0,0,0,0)) / 86400000);
      if (diff < 0)       key = groupOverdue;
      else if (diff === 0) key = groupToday;
      else if (diff <= 3)  key = groupThisWeek;
      else if (diff <= 7)  key = groupNextWeek;
      else                 key = groupLater;
    }
    (groups[key] = groups[key] || []).push(task);
  }

  const order = [groupOverdue, groupToday, groupThisWeek, groupNextWeek, groupLater, groupNoDate];
  return order.filter((k) => groups[k]).map((k) => [k, groups[k]]);
}

// --------------------------------------------------------
// Render-Bausteine
// --------------------------------------------------------

function renderPriorityBadge(priority) {
  if (priority === 'none') return '';
  return `<span class="priority-badge priority-badge--${priority}">
    <span class="priority-dot priority-dot--${priority}"></span>
    ${PRIORITY_LABELS()[priority] ?? priority}
  </span>`;
}

function renderDueDate(dateStr, timeStr) {
  const d = formatDueDate(dateStr, timeStr);
  if (!d) return '';
  return `<span class="due-date ${d.cls}">
    <i data-lucide="clock" class="icon-sm" aria-hidden="true"></i> ${d.label}
  </span>`;
}

function renderStartDateBadge(startDateStr) {
  if (!startDateStr) return '';
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const startDay = new Date(`${startDateStr}T00:00:00`);
  if (startDay <= today) return '';
  return `<span class="due-date">
    <i data-lucide="calendar-clock" class="icon-sm" aria-hidden="true"></i> ${t('tasks.startsOn', { date: formatDate(startDay) })}
  </span>`;
}

function renderSwipeRow(task, innerHtml) {
  const isDone = task.status === 'done';
  return `
    <div class="swipe-row" data-swipe-id="${task.id}" data-swipe-status="${task.status}">
      <div class="swipe-reveal swipe-reveal--done" aria-hidden="true">
        <i data-lucide="${isDone ? 'rotate-ccw' : 'check'}" class="icon-xl" aria-hidden="true"></i>
        <span>${isDone ? t('tasks.swipeOpen') : t('tasks.swipeDone')}</span>
      </div>
      <div class="swipe-reveal swipe-reveal--edit" aria-hidden="true">
        <i data-lucide="pencil" class="icon-xl" aria-hidden="true"></i>
        <span>${t('tasks.swipeEdit')}</span>
      </div>
      ${innerHtml}
    </div>`;
}

function renderTaskCard(task, opts = {}) {
  const { expandedSubtasks = false, showCheckbox = false, isChecked = false } = opts;
  const isDone = task.status === 'done';
  const progress = task.subtask_total > 0
    ? Math.round((task.subtask_done / task.subtask_total) * 100)
    : null;

  const subtasksHtml = task.subtasks?.length
    ? task.subtasks.map((s) => `
        <div class="subtask-item ${s.status === 'done' ? 'subtask-item--done' : ''}"
             data-subtask-id="${s.id}">
          <button class="subtask-item__checkbox ${s.status === 'done' ? 'subtask-item__checkbox--done' : ''}"
                  data-action="toggle-subtask" data-id="${s.id}"
                  data-status="${s.status}" aria-label="${t('tasks.subtaskMarkDone', { title: esc(s.title) })}">
            ${s.status === 'done' ? '<i data-lucide="check" class="subtask-item__checkbox-icon" aria-hidden="true"></i>' : ''}
          </button>
          <span class="subtask-item__title">${esc(s.title)}</span>
        </div>`).join('')
    : '';

  return `
    <div class="task-card ${isDone ? 'task-card--done' : ''}" data-task-id="${task.id}">
      <div class="task-card__main">
        ${showCheckbox ? `
        <input type="checkbox" class="task-bulk-checkbox" data-task-id="${task.id}"
               ${isChecked ? 'checked' : ''} aria-label="${t('tasks.selectTask')}">
        ` : ''}
        <button class="task-status-btn task-status-btn--${task.status}"
                data-action="toggle-status" data-id="${task.id}" data-status="${task.status}"
                aria-label="${isDone ? t('tasks.markOpen', { title: esc(task.title) }) : t('tasks.markDone', { title: esc(task.title) })}">
          <i data-lucide="check" class="task-status-btn__check" aria-hidden="true"></i>
        </button>

        <div class="task-card__body">
          <div class="task-card__title" data-action="open-task" data-id="${task.id}">
            ${esc(task.title)}
          </div>
          <div class="task-card__meta">
            ${renderPriorityBadge(task.priority)}
            ${renderStartDateBadge(task.start_date)}
            ${renderDueDate(task.due_date, task.due_time)}
            ${task.is_recurring ? `<span class="due-date" aria-label="${t('tasks.recurring')}"><i data-lucide="repeat" class="icon-sm" aria-hidden="true"></i></span>` : ''}
            ${task.category !== 'misc' ? `<span class="due-date">${CATEGORY_LABELS()[task.category] ?? task.category}</span>` : ''}
          </div>
        </div>

        ${renderAvatarStack(task.assigned_users ?? [], { size: 28 })}

        <button class="btn btn--ghost btn--icon btn--icon-sm" data-action="edit-task" data-id="${task.id}"
                aria-label="${t('tasks.editButton')}">
          <i data-lucide="pencil" class="icon-md" aria-hidden="true"></i>
        </button>
        ${task.status !== 'archived' ? `
        <button class="btn btn--ghost btn--icon btn--icon-sm" data-action="archive-task" data-id="${task.id}"
                aria-label="${t('tasks.archiveButton')}">
          <i data-lucide="archive" class="icon-md" aria-hidden="true"></i>
        </button>` : ''}
      </div>

      ${progress !== null ? `
        <div class="subtask-progress" data-action="toggle-subtasks" data-id="${task.id}"
             aria-label="${t('tasks.subtaskToggle')}">
          <div class="subtask-progress__bar-wrap">
            <div class="subtask-progress__bar-fill" style="width:${progress}%"></div>
          </div>
          <span class="subtask-progress__text">${task.subtask_done}/${task.subtask_total}</span>
        </div>` : ''}

      ${task.subtasks !== undefined ? `
        <div class="subtask-list ${expandedSubtasks ? 'subtask-list--visible' : ''}"
             id="subtasks-${task.id}">
          ${subtasksHtml}
          <button class="subtask-item__add" data-action="add-subtask" data-parent="${task.id}">
            ${t('tasks.subtaskAdd')}
          </button>
        </div>` : ''}
    </div>`;
}

// Effektive Fälligkeit: mit due_time wenn vorhanden, sonst 23:59:59 des Tages
function effectiveDue(task) {
  if (!task.due_date) return null;
  return task.due_time
    ? new Date(`${task.due_date}T${task.due_time}`)
    : new Date(`${task.due_date}T23:59:59`);
}

// Einheitliche Sortierung: überfällig zuerst → Datum/Zeit ASC → Prio als Tiebreaker
function sortTasks(a, b, now) {
  const aDate = effectiveDue(a);
  const bDate = effectiveDue(b);
  const aOver = aDate && aDate < now ? 1 : 0;
  const bOver = bDate && bDate < now ? 1 : 0;
  if (bOver !== aOver) return bOver - aOver;
  if (!aDate && !bDate) return (PRIO_ORDER[a.priority] ?? 4) - (PRIO_ORDER[b.priority] ?? 4);
  if (!aDate) return 1;
  if (!bDate) return -1;
  if (aDate.getTime() !== bDate.getTime()) return aDate < bDate ? -1 : 1;
  return (PRIO_ORDER[a.priority] ?? 4) - (PRIO_ORDER[b.priority] ?? 4);
}

function renderTaskGroups(tasks, groupMode) {
  if (!tasks.length) {
    return `<div class="empty-state">
      <svg class="empty-state__icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
        <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/>
        <polyline points="22 4 12 14.01 9 11.01"/>
      </svg>
      <div class="empty-state__title">${t('tasks.emptyTitle')}</div>
      <div class="empty-state__description">${t('tasks.emptyDescription')}</div>
      <p class="empty-state__hint">${t('emptyHint.tasks')}</p>
      <button class="btn btn--primary empty-state__cta" id="empty-cta-tasks">
        <i data-lucide="plus" aria-hidden="true" class="icon-md"></i>
        ${t('tasks.emptyAction')}
      </button>
    </div>`;
  }

  const now = new Date();
  const catLabelsMap = CATEGORY_LABELS();
  const groups = groupBy(tasks, groupMode);
  return groups.map(([name, groupTasks]) => {
    const sorted = [...groupTasks].sort((a, b) => sortTasks(a, b, now));
    return `
    <div class="task-group">
      <div class="task-group__header">
        <span class="task-group__title">${catLabelsMap[name] ?? name}</span>
        <span class="task-group__count">${groupTasks.length}</span>
      </div>
      ${sorted.map((t) => renderSwipeRow(t, renderTaskCard(t, {
        showCheckbox: state.bulkSelectMode,
        isChecked: state.selectedTaskIds.has(t.id),
      }))).join('')}
    </div>`;
  }).join('');
}

// --------------------------------------------------------
// Task-Modal (Erstellen / Bearbeiten)
// --------------------------------------------------------

function renderModalContent({ task = null, users = [], reminder = null } = {}) {
  const isEdit = !!task;

  const selectedIds = task?.assigned_users?.map((u) => u.id) ?? (task?.assigned_to ? [task.assigned_to] : []);

  const catLabels = CATEGORY_LABELS();
  const categoryOptions = CATEGORIES.map((c) =>
    `<option value="${c}" ${(task?.category ?? 'Sonstiges') === c ? 'selected' : ''}>${catLabels[c] ?? c}</option>`
  ).join('');

  const priorityOptions = PRIORITIES().map((p) =>
    `<option value="${p.value}" ${(task?.priority ?? 'none') === p.value ? 'selected' : ''}>${p.label}</option>`
  ).join('');

  return `
    <form id="task-form" novalidate>
      <input type="hidden" id="task-id" value="${task?.id ?? ''}">

      <div class="form-group">
        <div class="form-field">
          <label class="label" for="task-title">${t('tasks.titleLabel')}<span class="required-marker" aria-hidden="true"> *</span></label>
          <input class="input" type="text" id="task-title" name="title"
                 value="${esc(task?.title)}" placeholder="${t('tasks.titlePlaceholder')}"
                 required autocomplete="off">
          <div class="form-field__error">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                 stroke-width="2" aria-hidden="true"><circle cx="12" cy="12" r="10"/>
                 <line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12" y2="16.01"/>
            </svg>
            ${t('common.required')}
          </div>
        </div>
      </div>

      <div class="form-group">
        <label class="label" for="task-description">${t('tasks.descriptionLabel')}</label>
        <textarea class="input" id="task-description" name="description"
                  rows="2" placeholder="${t('tasks.descriptionPlaceholder')}"
                 >${esc(task?.description)}</textarea>
      </div>

      <div class="modal-grid modal-grid--2">
        <div class="form-group">
          <label class="label" for="task-priority">${t('tasks.priorityLabel')}</label>
          <select class="input" id="task-priority" name="priority">
            ${priorityOptions}
          </select>
        </div>
        <div class="form-group">
          <label class="label" for="task-category">${t('tasks.categoryLabel')}</label>
          <select class="input" id="task-category" name="category">
            ${categoryOptions}
          </select>
        </div>
      </div>

      <div class="form-group" style="margin-top:var(--space-4)">
        <label class="label" for="task-start-date">${t('tasks.startDateLabel')}</label>
        <input class="input js-date-input" type="text" id="task-start-date" name="start_date"
               value="${formatDateInput(task?.start_date)}" placeholder="${dateInputPlaceholder()}" inputmode="text">
      </div>

      <div class="modal-grid modal-grid--2" style="margin-top:var(--space-4)">
        <div class="form-group">
          <label class="label" for="task-due-date">${t('tasks.dueDateLabel')}</label>
          <input class="input js-date-input" type="text" id="task-due-date" name="due_date"
                 value="${formatDateInput(task?.due_date)}" placeholder="${dateInputPlaceholder()}" inputmode="text">
        </div>
        <div class="form-group">
          <label class="label" for="task-due-time">${t('tasks.dueTimeLabel')}</label>
          <input class="input js-time-input" type="text" id="task-due-time" name="due_time"
                 value="${formatTimeInput(task?.due_time ?? '')}" placeholder="${timeInputPlaceholder()}">
        </div>
      </div>

      <div class="form-group" style="margin-top:var(--space-4)">
        ${renderUserMultiSelect(users, selectedIds, 'task_assigned', 'tasks.assignedLabel')}
      </div>

      ${isEdit ? `
        <div class="form-group">
          <label class="label" for="task-status">${t('tasks.statusLabel')}</label>
          <select class="input" id="task-status" name="status">
            ${STATUSES().map((s) =>
              `<option value="${s.value}" ${task.status === s.value ? 'selected' : ''}>${s.label}</option>`
            ).join('')}
          </select>
        </div>` : ''}

      ${renderRRuleFields('task', task?.recurrence_rule)}

      ${renderReminderSection(task, reminder)}

      <div id="task-form-error" class="login-error" hidden></div>

      <div class="modal-panel__footer" style="padding:0;border:none;margin-top:var(--space-6)">
        ${isEdit ? `
          <button type="button" class="btn btn--danger" data-action="delete-task"
                  data-id="${task.id}">${t('common.delete')}</button>` : ''}
        <button type="submit" class="btn btn--primary" id="task-submit-btn">
          ${isEdit ? t('common.save') : t('common.create')}
        </button>
      </div>
    </form>`;
}

// --------------------------------------------------------
// Seiten-State
// --------------------------------------------------------

let state = {
  tasks:           [],
  users:           [],
  filters:         { status: 'open', priority: '', assigned_to: '' },
  groupMode:       'category',   // 'category' | 'due'
  viewMode:        'list',       // 'list' | 'kanban' (resolved at render time)
  showFuture:      false,
  expandedTasks:   new Set(),
  dragTaskId:      null,
  filterPanelOpen: false,
  bulkSelectMode:  false,
  selectedTaskIds: new Set(),
};

// --------------------------------------------------------
// API-Aktionen
// --------------------------------------------------------

async function loadTasks(container) {
  const params = new URLSearchParams();
  if (state.filters.status)      params.set('status',      state.filters.status);
  if (state.filters.priority)    params.set('priority',    state.filters.priority);
  if (state.filters.assigned_to) params.set('assigned_to', state.filters.assigned_to);
  if (state.showFuture)          params.set('include_future', '1');

  const query = params.toString() ? `?${params}` : '';
  const data  = await api.get(`/tasks${query}`);
  state.tasks = data.data ?? [];
  renderTaskList(container);
}

async function toggleTaskStatus(id, currentStatus) {
  const next = currentStatus === 'done' ? 'open' : 'done';
  await api.patch(`/tasks/${id}/status`, { status: next });
}

async function toggleSubtaskStatus(id, currentStatus) {
  const next = currentStatus === 'done' ? 'open' : 'done';
  await api.patch(`/tasks/${id}/status`, { status: next });
}

async function loadTaskForEdit(id) {
  const data = await api.get(`/tasks/${id}`);
  return data.data;
}

async function loadReminderForTask(taskId) {
  try {
    const data = await api.get(`/reminders?entity_type=task&entity_id=${taskId}`);
    return data.data;
  } catch {
    return null;
  }
}

function parseOffsetMsFromReminder(task, reminder) {
  if (!task?.due_date || !reminder?.remind_at) return null;
  const due = task.due_time ? new Date(`${task.due_date}T${task.due_time}`) : new Date(`${task.due_date}T23:59:59`);
  const remind = new Date(reminder.remind_at);
  if (Number.isNaN(due.getTime()) || Number.isNaN(remind.getTime())) return null;
  return due.getTime() - remind.getTime();
}

function resolveReminderPreset(task, reminder) {
  const offset = parseOffsetMsFromReminder(task, reminder);
  if (offset === null) return { preset: 'offset_15m', amount: '15', unit: 'minutes' };
  const map = new Map([
    [0, 'offset_at_time'],
    [15 * 60 * 1000, 'offset_15m'],
    [60 * 60 * 1000, 'offset_1h'],
    [24 * 60 * 60 * 1000, 'offset_1d'],
    [2 * 24 * 60 * 60 * 1000, 'offset_2d'],
    [7 * 24 * 60 * 60 * 1000, 'offset_1w'],
    [14 * 24 * 60 * 60 * 1000, 'offset_2w'],
  ]);
  if (map.has(offset)) return { preset: map.get(offset), amount: '1', unit: 'days' };
  const minutes = Math.round(offset / 60000);
  if (minutes > 0) return { preset: 'offset_custom', amount: String(minutes), unit: 'minutes' };
  return { preset: 'offset_at_time', amount: '1', unit: 'days' };
}

function renderReminderSection(task = null, reminder = null) {
  const hasReminder = !!reminder;
  const resolved = resolveReminderPreset(task, reminder);
  const showCustom = hasReminder && resolved.preset === 'offset_custom';

  return `
    <div class="reminder-section">
      <div class="reminder-section__header">
        <label class="toggle" style="margin:0">
          <input type="checkbox" id="reminder-toggle" ${hasReminder ? 'checked' : ''}>
          <span class="toggle__track"></span>
          <span class="reminder-section__title">${t('reminders.enableLabel')}</span>
        </label>
      </div>
      <div id="reminder-fields" class="reminder-fields" ${hasReminder ? '' : 'style="display:none"'}>
        <div class="form-group" style="margin:0">
          <label class="label" for="reminder-offset">${t('reminders.offsetLabel')}</label>
          <select class="input" id="reminder-offset">
            <option value="offset_none">${t('reminders.offsetNone')}</option>
            <option value="offset_at_time" ${resolved.preset === 'offset_at_time' ? 'selected' : ''}>${t('reminders.offsetAtTime')}</option>
            <option value="offset_15m" ${resolved.preset === 'offset_15m' ? 'selected' : ''}>${t('reminders.offset15min')}</option>
            <option value="offset_1h" ${resolved.preset === 'offset_1h' ? 'selected' : ''}>${t('reminders.offset1hour')}</option>
            <option value="offset_1d" ${resolved.preset === 'offset_1d' ? 'selected' : ''}>${t('reminders.offset1day')}</option>
            <option value="offset_2d" ${resolved.preset === 'offset_2d' ? 'selected' : ''}>${t('reminders.offset2days')}</option>
            <option value="offset_1w" ${resolved.preset === 'offset_1w' ? 'selected' : ''}>${t('reminders.offset1week')}</option>
            <option value="offset_2w" ${resolved.preset === 'offset_2w' ? 'selected' : ''}>${t('reminders.offset2weeks')}</option>
            <option value="offset_custom" ${resolved.preset === 'offset_custom' ? 'selected' : ''}>${t('reminders.offsetCustom')}</option>
          </select>
        </div>
        <div class="modal-grid modal-grid--2" id="reminder-custom-fields" style="${showCustom ? '' : 'display:none'};margin-top:var(--space-3)">
          <div class="form-group" style="margin:0">
            <label class="label" for="reminder-custom-amount">${t('reminders.customAmountLabel')}</label>
            <input class="input" type="number" min="1" step="1" id="reminder-custom-amount" value="${resolved.amount}">
          </div>
          <div class="form-group" style="margin:0">
            <label class="label" for="reminder-custom-unit">${t('reminders.customUnitLabel')}</label>
            <select class="input" id="reminder-custom-unit">
              <option value="minutes" ${resolved.unit === 'minutes' ? 'selected' : ''}>${t('reminders.customMinutes')}</option>
              <option value="hours" ${resolved.unit === 'hours' ? 'selected' : ''}>${t('reminders.customHours')}</option>
              <option value="days" ${resolved.unit === 'days' ? 'selected' : ''}>${t('reminders.customDays')}</option>
              <option value="weeks" ${resolved.unit === 'weeks' ? 'selected' : ''}>${t('reminders.customWeeks')}</option>
            </select>
          </div>
        </div>
      </div>
    </div>`;
}

// --------------------------------------------------------
// Modal-Verwaltung (delegiert an Shared Modal-System)
// --------------------------------------------------------

function openTaskModal({ task = null, users = [], reminder = null } = {}, container) {
  const isEdit = !!task;
  openSharedModal({
    title: isEdit ? t('tasks.editTask') : t('tasks.newTask'),
    content: renderModalContent({ task, users, reminder }),
    size: 'lg',
    onSave(panel) {
      panel.querySelector('.modal-panel__body')?.classList.add('modal-panel__body--tasks-fit');
      // RRULE-Events binden
      bindRRuleEvents(document, 'task');
      bindUserMultiSelect(panel, 'task_assigned');

      // Blur-Validierung für required-Felder aktivieren
      wireBlurValidation(panel);

      // Reminder-Toggle: Felder ein-/ausblenden
      const toggle = panel.querySelector('#reminder-toggle');
      const fields = panel.querySelector('#reminder-fields');
      const offset = panel.querySelector('#reminder-offset');
      const customFields = panel.querySelector('#reminder-custom-fields');
      toggle?.addEventListener('change', () => {
        fields.style.display = toggle.checked ? '' : 'none';
      });
      offset?.addEventListener('change', () => {
        if (!customFields) return;
        customFields.style.display = offset.value === 'offset_custom' ? '' : 'none';
      });
      panel.querySelectorAll('.js-date-input').forEach((input) => {
        input.addEventListener('blur', () => {
          const parsed = parseDateInput(input.value);
          if (parsed) input.value = formatDateInput(parsed);
        });
      });
      panel.querySelectorAll('.js-time-input').forEach((input) => {
        input.addEventListener('blur', () => {
          const parsed = parseTimeInput(input.value);
          if (parsed) input.value = formatTimeInput(parsed);
        });
      });

      // Form-Events
      panel.querySelector('#task-form')
        ?.addEventListener('submit', (e) => handleFormSubmit(e, container));

      panel.querySelector('[data-action="delete-task"]')
        ?.addEventListener('click', (e) => handleDeleteTask(e.currentTarget.dataset.id, container));
    },
  });
}

// --------------------------------------------------------
// Formular-Handler
// --------------------------------------------------------

async function handleFormSubmit(e, container) {
  e.preventDefault();
  const form      = e.target;
  const errorEl   = document.getElementById('task-form-error');
  const submitBtn = document.getElementById('task-submit-btn');
  const taskId    = document.getElementById('task-id').value;

  // Alle required-Felder sofort validieren (auch unberührte)
  if (!validateAll(form)) return;

  errorEl.hidden = true;
  submitBtn.disabled = true;
  submitBtn.textContent = t('common.saving');

  const originalLabel = taskId ? t('common.save') : t('common.create');

  const startDateRaw = form.start_date?.value || '';
  const startDate = parseDateInput(startDateRaw);
  const dueDateRaw = form.due_date?.value || '';
  const dueDate = parseDateInput(dueDateRaw);
  const rrule = getRRuleValues(document, 'task');
  const reminderToggle = form.querySelector('#reminder-toggle');
  if ((startDateRaw && !isDateInputValid(startDateRaw)) || !isDateInputValid(dueDateRaw) || !rrule.valid_until) {
    errorEl.textContent = t('calendar.invalidDate');
    errorEl.hidden = false;
    submitBtn.disabled = false;
    submitBtn.textContent = originalLabel;
    return;
  }
  const body = {
    title:           form.title.value.trim(),
    description:     form.description.value.trim() || null,
    priority:        form.priority.value,
    category:        form.category.value,
    start_date:      startDate || null,
    due_date:        dueDate || null,
    assigned_to:     getSelectedUserIds(form, 'task_assigned'),
    is_recurring:    rrule.is_recurring ? 1 : 0,
    recurrence_rule: rrule.recurrence_rule,
  };
  const dueTimeRaw = form.due_time?.value || '';
  const dueTime = parseTimeInput(dueTimeRaw);
  if (dueTimeRaw && !dueTime) {
    errorEl.textContent = t('calendar.invalidDate');
    errorEl.hidden = false;
    submitBtn.disabled = false;
    submitBtn.textContent = originalLabel;
    return;
  }
  body.due_time = dueTime || null;
  if (form.status) body.status = form.status.value;

  try {
    let savedTaskId = taskId;
    if (taskId) {
      await api.put(`/tasks/${taskId}`, body);
      window.oikos.showToast(t('tasks.savedToast'), 'success');
    } else {
      const res = await api.post('/tasks', body);
      savedTaskId = res.data?.id;
      window.oikos.showToast(t('tasks.createdToast'), 'success');
    }

    // Erinnerung speichern oder löschen
    if (savedTaskId) {
      if (reminderToggle?.checked) {
        if (!dueDate) throw new Error(t('tasks.reminderNeedsDueDate'));
        const dueDateTime = body.due_time ? new Date(`${dueDate}T${body.due_time}`) : new Date(`${dueDate}T23:59:59`);
        const offsetPreset = form.querySelector('#reminder-offset')?.value || 'offset_none';
        if (offsetPreset === 'offset_none') throw new Error(t('tasks.reminderNeedsDueDate'));
        let offsetMs = 0;
        if (offsetPreset === 'offset_15m') offsetMs = 15 * 60 * 1000;
        else if (offsetPreset === 'offset_1h') offsetMs = 60 * 60 * 1000;
        else if (offsetPreset === 'offset_1d') offsetMs = 24 * 60 * 60 * 1000;
        else if (offsetPreset === 'offset_2d') offsetMs = 2 * 24 * 60 * 60 * 1000;
        else if (offsetPreset === 'offset_1w') offsetMs = 7 * 24 * 60 * 60 * 1000;
        else if (offsetPreset === 'offset_2w') offsetMs = 14 * 24 * 60 * 60 * 1000;
        else if (offsetPreset === 'offset_custom') {
          const customAmount = Number(form.querySelector('#reminder-custom-amount')?.value || 0);
          const customUnit = form.querySelector('#reminder-custom-unit')?.value || 'days';
          if (!Number.isFinite(customAmount) || customAmount <= 0) throw new Error(t('common.invalidInput'));
          const unitFactor = customUnit === 'minutes' ? 60000 : customUnit === 'hours' ? 3600000 : customUnit === 'days' ? 86400000 : 604800000;
          offsetMs = customAmount * unitFactor;
        }
        const remindAtDate = new Date(dueDateTime.getTime() - offsetMs);
        const remindAt = remindAtDate.toISOString().slice(0, 19);
        await api.post('/reminders', { entity_type: 'task', entity_id: savedTaskId, remind_at: remindAt });
        refreshReminders();
      } else if (!reminderToggle?.checked) {
        try {
          await api.delete(`/reminders?entity_type=task&entity_id=${savedTaskId}`);
          refreshReminders();
        } catch { /* kein Reminder vorhanden - ignorieren */ }
      }
    }

    btnSuccess(submitBtn, originalLabel);
    setTimeout(() => closeModal({ force: true }), 700);
    await loadTasks(container);
  } catch (err) {
    errorEl.textContent = err.message;
    errorEl.hidden = false;
    submitBtn.disabled = false;
    submitBtn.textContent = originalLabel;
    btnError(submitBtn);
  }
}

async function handleDeleteTask(id, container) {
  closeModal({ force: true });
  const itemEl = container.querySelector(`[data-task-id="${id}"]`);
  if (itemEl) itemEl.style.display = 'none';

  let undone = false;
  window.oikos.showToast(t('tasks.deletedToast'), 'default', 5000, () => {
    undone = true;
    if (itemEl) itemEl.style.display = '';
  });

  setTimeout(async () => {
    if (undone) return;
    try {
      await api.delete(`/tasks/${id}`);
      // Erinnerungen für diese Aufgabe ebenfalls entfernen
      api.delete(`/reminders?entity_type=task&entity_id=${id}`).catch(() => {});
      refreshReminders();
      await loadTasks(container);
    } catch (err) {
      if (itemEl) itemEl.style.display = '';
      window.oikos.showToast(err.message ?? t('common.unknownError'), 'danger');
    }
  }, 5000);
}

async function handleAddSubtask(parentId, container) {
  const title = await promptModal(t('tasks.subtaskPrompt'));
  if (!title) return;
  try {
    await api.post('/tasks', { title, parent_task_id: parentId });
    await loadTasks(container);
  } catch (err) {
    window.oikos.showToast(err.message, 'danger');
  }
}

// --------------------------------------------------------
// Kanban-Ansicht
// --------------------------------------------------------

const KANBAN_COLS = () => [
  { status: 'open',        label: t('tasks.kanbanOpen'),       colorVar: '--color-text-secondary' },
  { status: 'in_progress', label: t('tasks.kanbanInProgress'), colorVar: '--color-warning'        },
  { status: 'done',        label: t('tasks.kanbanDone'),       colorVar: '--color-success'        },
  { status: 'archived',    label: t('tasks.kanbanArchived'),   colorVar: '--color-text-tertiary'  },
];

function kanbanNextStatus(status) {
  if (status === 'open')        return 'in_progress';
  if (status === 'in_progress') return 'done';
  return 'open';
}

function renderKanbanCard(task) {
  const due  = formatDueDate(task.due_date, task.due_time);
  const next = kanbanNextStatus(task.status);
  const icon = next === 'done' ? 'check' : next === 'in_progress' ? 'circle-play' : 'rotate-ccw';
  const nextLabel = next === 'done'
    ? t('tasks.kanbanMoveToDone')
    : next === 'in_progress'
      ? t('tasks.kanbanMoveToInProgress')
      : t('tasks.kanbanMoveToOpen');
  return `
    <div class="kanban-card ${task.status === 'done' ? 'kanban-card--done' : ''}"
         data-task-id="${task.id}" draggable="true">
      <div class="kanban-card__title">${esc(task.title)}</div>
      <div class="kanban-card__meta">
        ${renderPriorityBadge(task.priority)}
        ${due ? `<span class="due-date ${due.cls}"><i data-lucide="clock" class="icon-sm" aria-hidden="true"></i> ${due.label}</span>` : ''}
      </div>
      <div class="kanban-card__footer">
        ${renderAvatarStack(task.assigned_users ?? [], { size: 22 }) || '<span></span>'}
        <button class="kanban-card__status-btn" type="button"
                data-next-status="${next}" title="${nextLabel}" aria-label="${nextLabel}">
          <i data-lucide="${icon}" aria-hidden="true"></i>
        </button>
      </div>
    </div>`;
}

function renderKanban(container) {
  const listEl = container.querySelector('#task-list');
  if (!listEl) return;

  const cols = KANBAN_COLS();
  const grouped = {};
  for (const col of cols) grouped[col.status] = [];
  for (const t of state.tasks) {
    if (grouped[t.status]) grouped[t.status].push(t);
    else grouped['open'].push(t);
  }

  const now = new Date();
  for (const col of cols) {
    grouped[col.status].sort((a, b) => sortTasks(a, b, now));
  }

  const kanbanHtml = `
    <div class="kanban-board">
      ${cols.map((col) => `
        <div class="kanban-col" data-status="${col.status}">
          <div class="kanban-col__header">
            <span class="kanban-col__title" style="color:${col.colorVar.startsWith('--') ? `var(${col.colorVar})` : col.colorVar}">
              ${col.label}
            </span>
            <span class="kanban-col__count">${grouped[col.status].length}</span>
          </div>
          <div class="kanban-col__body" data-drop-zone="${col.status}">
            ${grouped[col.status].map((t) => renderKanbanCard(t)).join('')}
            <div class="kanban-drop-placeholder" hidden></div>
          </div>
        </div>
      `).join('')}
    </div>`;
  listEl.replaceChildren();
  listEl.insertAdjacentHTML('beforeend', kanbanHtml);

  if (window.lucide) window.lucide.createIcons();
  wireKanbanDrag(container);
  wireKanbanTouch(container);
  updateOverdueBadge();
}

function wireKanbanDrag(container) {
  const board = container.querySelector('.kanban-board');
  if (!board) return;

  board.addEventListener('dragstart', (e) => {
    const card = e.target.closest('.kanban-card[data-task-id]');
    if (!card) return;
    state.dragTaskId = card.dataset.taskId;
    card.classList.add('kanban-card--dragging');
    e.dataTransfer.effectAllowed = 'move';
  });

  board.addEventListener('dragend', (e) => {
    const card = e.target.closest('.kanban-card[data-task-id]');
    if (card) card.classList.remove('kanban-card--dragging');
    board.querySelectorAll('.kanban-drop-placeholder').forEach((el) => el.hidden = true);
    board.querySelectorAll('.kanban-col__body--over').forEach((el) =>
      el.classList.remove('kanban-col__body--over')
    );
    state.dragTaskId = null;
  });

  board.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const zone = e.target.closest('[data-drop-zone]');
    if (!zone) return;
    board.querySelectorAll('.kanban-col__body--over').forEach((el) =>
      el.classList.remove('kanban-col__body--over')
    );
    zone.classList.add('kanban-col__body--over');
  });

  board.addEventListener('dragleave', (e) => {
    const zone = e.target.closest('[data-drop-zone]');
    if (zone && !zone.contains(e.relatedTarget)) {
      zone.classList.remove('kanban-col__body--over');
    }
  });

  board.addEventListener('drop', async (e) => {
    e.preventDefault();
    const zone = e.target.closest('[data-drop-zone]');
    if (!zone || !state.dragTaskId) return;
    zone.classList.remove('kanban-col__body--over');

    const newStatus = zone.dataset.dropZone;
    const taskId    = state.dragTaskId;
    const task      = state.tasks.find((t) => String(t.id) === String(taskId));
    if (!task || task.status === newStatus) return;

    // Optimistisches Update
    task.status = newStatus;
    renderKanban(container);

    try {
      await api.patch(`/tasks/${taskId}/status`, { status: newStatus });
      await loadTasks(container); // sync
    } catch (err) {
      window.oikos.showToast(err.message, 'danger');
      await loadTasks(container);
    }
  });

  // Klick auf Status-Button: Status ohne Modal wechseln
  board.addEventListener('click', async (e) => {
    const statusBtn = e.target.closest('[data-next-status]');
    if (statusBtn) {
      e.stopPropagation();
      const card      = statusBtn.closest('.kanban-card[data-task-id]');
      if (!card) return;
      const taskId    = card.dataset.taskId;
      const newStatus = statusBtn.dataset.nextStatus;
      const task      = state.tasks.find((t) => String(t.id) === String(taskId));
      if (!task) return;
      task.status = newStatus;
      renderKanban(container);
      try {
        await api.patch(`/tasks/${taskId}/status`, { status: newStatus });
        await loadTasks(container);
      } catch (err) {
        window.oikos.showToast(err.message, 'danger');
        await loadTasks(container);
      }
      return;
    }

    // Klick auf Kanban-Card öffnet Edit-Modal
    if (e.target.closest('[draggable]')) {
      const card = e.target.closest('.kanban-card[data-task-id]');
      if (!card) return;
      try {
        const [task, reminder] = await Promise.all([
          loadTaskForEdit(card.dataset.taskId),
          loadReminderForTask(card.dataset.taskId),
        ]);
        openTaskModal({ task, users: state.users, reminder }, container);
      } catch (err) {
        window.oikos.showToast(t('tasks.loadError'), 'danger');
      }
    }
  });
}

// --------------------------------------------------------
// Kanban-Touch-Drag (Mobile)
// --------------------------------------------------------

function wireKanbanTouch(container) {
  const board = container.querySelector('.kanban-board');
  if (!board) return;

  let dragging = null;
  let ghost = null;
  let taskId = null;
  let originX = 0, originY = 0;
  let originLeft = 0, originTop = 0;
  let activeZone = null;
  let started = false;

  function cleanup() {
    ghost?.remove();
    ghost = null;
    if (dragging) {
      dragging.classList.remove('kanban-card--dragging');
      dragging = null;
    }
    board.querySelectorAll('.kanban-col__body--over').forEach((el) =>
      el.classList.remove('kanban-col__body--over')
    );
    activeZone = null;
    started = false;
    taskId = null;
  }

  board.addEventListener('touchstart', (e) => {
    const card = e.target.closest('.kanban-card[data-task-id]');
    if (!card || e.target.closest('[data-next-status]')) return;
    dragging = card;
    taskId = card.dataset.taskId;
    const touch = e.touches[0];
    originX = touch.clientX;
    originY = touch.clientY;
    const rect = card.getBoundingClientRect();
    originLeft = rect.left;
    originTop = rect.top;
    started = false;
  }, { passive: true });

  board.addEventListener('touchmove', (e) => {
    if (!dragging) return;
    const touch = e.touches[0];
    const dx = touch.clientX - originX;
    const dy = touch.clientY - originY;

    if (!started && Math.sqrt(dx * dx + dy * dy) < 8) return;

    if (!started) {
      started = true;
      ghost = dragging.cloneNode(true);
      ghost.className = 'kanban-card kanban-card--ghost';
      ghost.style.width = dragging.getBoundingClientRect().width + 'px';
      ghost.style.left = originLeft + 'px';
      ghost.style.top = originTop + 'px';
      document.body.appendChild(ghost);
      dragging.classList.add('kanban-card--dragging');
    }

    e.preventDefault();
    ghost.style.left = (originLeft + dx) + 'px';
    ghost.style.top = (originTop + dy) + 'px';

    ghost.style.visibility = 'hidden';
    const el = document.elementFromPoint(touch.clientX, touch.clientY);
    ghost.style.visibility = '';

    const zone = el?.closest('[data-drop-zone]');
    board.querySelectorAll('.kanban-col__body--over').forEach((z) =>
      z.classList.remove('kanban-col__body--over')
    );
    if (zone) {
      zone.classList.add('kanban-col__body--over');
      activeZone = zone;
    } else {
      activeZone = null;
    }
  }, { passive: false });

  board.addEventListener('touchend', async () => {
    if (!dragging) return;
    const zone = activeZone;
    const tid = taskId;
    const task = state.tasks.find((tk) => String(tk.id) === String(tid));
    cleanup();

    if (!zone || !task) return;
    const newStatus = zone.dataset.dropZone;
    if (task.status === newStatus) return;

    task.status = newStatus;
    renderKanban(container);
    try {
      await api.patch(`/tasks/${tid}/status`, { status: newStatus });
      await loadTasks(container);
    } catch (err) {
      window.oikos.showToast(err.message, 'danger');
      await loadTasks(container);
    }
  }, { passive: true });

  board.addEventListener('touchcancel', cleanup, { passive: true });
}

// --------------------------------------------------------
// Partielle DOM-Updates
// --------------------------------------------------------

function renderTaskList(container) {
  if (state.viewMode === 'kanban') {
    renderKanban(container);
    return;
  }
  const listEl = container.querySelector('#task-list');
  if (!listEl) return;
  listEl.replaceChildren();
  listEl.insertAdjacentHTML('beforeend', renderTaskGroups(state.tasks, state.groupMode));
  if (window.lucide) window.lucide.createIcons();
  stagger(listEl.querySelectorAll('.swipe-row, .kanban-card'));
  updateOverdueBadge();
  updateBulkActionsBar(container);
  wireSwipeGestures(container);
  maybeShowSwipeHint(container);
  listEl.querySelector('#empty-cta-tasks')?.addEventListener('click', () => {
    document.querySelector('.page-fab')?.click();
  });
}

function renderFilters(container) {
  const bar   = container.querySelector('#filter-bar');
  const panel = container.querySelector('#filter-panel');
  if (!bar || !panel) return;

  const statusLabels   = STATUS_LABELS();
  const priorityLabels = PRIORITY_LABELS();
  const activeCount    = [state.filters.status, state.filters.priority, state.filters.assigned_to]
    .filter(Boolean).length;

  // ---- Chip-Leiste: nur aktive Filter + Toggle-Button ----
  bar.replaceChildren();

  if (state.filters.status) {
    const chip = document.createElement('span');
    chip.className = 'filter-chip filter-chip--active';
    chip.dataset.filter = 'status';
    chip.textContent = statusLabels[state.filters.status];
    const rm = document.createElement('span');
    rm.className = 'filter-chip__remove';
    rm.setAttribute('aria-hidden', 'true');
    rm.textContent = '×';
    chip.appendChild(rm);
    bar.appendChild(chip);
  }
  if (state.filters.priority) {
    const chip = document.createElement('span');
    chip.className = 'filter-chip filter-chip--active';
    chip.dataset.filter = 'priority';
    chip.textContent = priorityLabels[state.filters.priority];
    const rm = document.createElement('span');
    rm.className = 'filter-chip__remove';
    rm.setAttribute('aria-hidden', 'true');
    rm.textContent = '×';
    chip.appendChild(rm);
    bar.appendChild(chip);
  }
  if (state.filters.assigned_to) {
    const u = state.users.find((u) => u.id === Number(state.filters.assigned_to));
    const chip = document.createElement('span');
    chip.className = 'filter-chip filter-chip--active';
    chip.dataset.filter = 'assigned_to';
    chip.textContent = u?.display_name ?? t('tasks.filterGroupPerson');
    const rm = document.createElement('span');
    rm.className = 'filter-chip__remove';
    rm.setAttribute('aria-hidden', 'true');
    rm.textContent = '×';
    chip.appendChild(rm);
    bar.appendChild(chip);
  }

  // "Geplante anzeigen" Toggle-Chip
  const futureChip = document.createElement('span');
  futureChip.className = `filter-chip${state.showFuture ? ' filter-chip--active' : ''}`;
  futureChip.id = 'filter-show-future';
  futureChip.textContent = t('tasks.showFuture');
  if (state.showFuture) {
    const rm = document.createElement('span');
    rm.className = 'filter-chip__remove';
    rm.setAttribute('aria-hidden', 'true');
    rm.textContent = '×';
    futureChip.appendChild(rm);
  }
  bar.appendChild(futureChip);

  const toggleBtn = document.createElement('button');
  toggleBtn.id = 'filter-toggle-btn';
  toggleBtn.className = `filter-toggle-btn${state.filterPanelOpen ? ' filter-toggle-btn--open' : ''}${activeCount > 0 ? ' filter-toggle-btn--active' : ''}`;
  toggleBtn.setAttribute('aria-expanded', String(state.filterPanelOpen));
  toggleBtn.setAttribute('aria-controls', 'filter-panel');

  const iconWrap = document.createElement('i');
  iconWrap.setAttribute('data-lucide', 'sliders-horizontal');
  iconWrap.className = 'icon-sm';
  iconWrap.setAttribute('aria-hidden', 'true');
  toggleBtn.appendChild(iconWrap);

  const label = document.createElement('span');
  label.textContent = t('tasks.filterBtn');
  toggleBtn.appendChild(label);

  if (activeCount > 0) {
    const badge = document.createElement('span');
    badge.className = 'filter-toggle-btn__count';
    badge.textContent = String(activeCount);
    toggleBtn.appendChild(badge);
  }

  bar.appendChild(toggleBtn);

  // ---- Zuletzt verwendete Filter als Quick-Chips ----
  const statusLabelsMap   = STATUS_LABELS();
  const priorityLabelsMap = PRIORITY_LABELS();
  const recent = getRecentFilters();
  recent.forEach((f) => {
    const parts = [];
    if (f.status)      parts.push(statusLabelsMap[f.status]   ?? f.status);
    if (f.priority)    parts.push(priorityLabelsMap[f.priority] ?? f.priority);
    if (f.assigned_to) {
      const u = state.users.find((u) => u.id === Number(f.assigned_to));
      if (u) parts.push(u.display_name);
    }
    if (!parts.length) return;
    const chip = document.createElement('span');
    chip.className = 'filter-chip filter-chip--recent';
    chip.dataset.recentFilter = JSON.stringify(f);
    chip.textContent = parts.join(' · ');
    bar.appendChild(chip);
  });

  if (window.lucide) window.lucide.createIcons({ el: bar });

  // ---- Filter-Panel: Gruppen mit allen Optionen ----
  panel.hidden = !state.filterPanelOpen;
  panel.replaceChildren();

  if (state.filterPanelOpen) {
    const groups = [
      {
        key: 'status',
        label: t('tasks.filterGroupStatus'),
        items: STATUSES().map((s) => ({ value: s.value, label: s.label })),
      },
      {
        key: 'priority',
        label: t('tasks.filterGroupPriority'),
        items: PRIORITIES().map((p) => ({ value: p.value, label: p.label })),
      },
    ];
    if (state.users.length > 1) {
      groups.push({
        key: 'assigned_to',
        label: t('tasks.filterGroupPerson'),
        items: state.users.map((u) => ({ value: String(u.id), label: u.display_name })),
      });
    }

    groups.forEach((group) => {
      const section = document.createElement('div');
      section.className = 'filter-panel__group';

      const heading = document.createElement('div');
      heading.className = 'filter-panel__label';
      heading.textContent = group.label;
      section.appendChild(heading);

      const row = document.createElement('div');
      row.className = 'filter-panel__chips';

      group.items.forEach((item) => {
        const isActive = state.filters[group.key] === item.value;
        const chip = document.createElement('span');
        chip.className = `filter-chip${isActive ? ' filter-chip--active' : ''}`;
        chip.dataset.filter = group.key;
        chip.dataset.value = item.value;
        chip.textContent = item.label;
        if (isActive) {
          const rm = document.createElement('span');
          rm.className = 'filter-chip__remove';
          rm.setAttribute('aria-hidden', 'true');
          rm.textContent = '×';
          chip.appendChild(rm);
        }
        row.appendChild(chip);
      });

      section.appendChild(row);
      panel.appendChild(section);
    });

    if (activeCount > 0) {
      const clearBtn = document.createElement('button');
      clearBtn.className = 'filter-panel__clear';
      clearBtn.id = 'filter-clear-all';
      clearBtn.textContent = t('tasks.filterClearAll');
      panel.appendChild(clearBtn);
    }
  }

  wireFilterChips(container);
}

function updateOverdueBadge() {
  const overdue = state.tasks.filter((t) => {
    if (!t.due_date || t.status === 'done') return false;
    return new Date(t.due_date) < new Date().setHours(0, 0, 0, 0);
  }).length;

  document.querySelectorAll('[data-route="/tasks"] .nav-badge').forEach((el) => el.remove());
  document.querySelectorAll('[data-route="/tasks"]').forEach((navItem) => {
    const baseLabel = t('tasks.title');
    navItem.setAttribute('aria-label', overdue > 0
      ? t('tasks.navLabelOverdue', { count: overdue })
      : baseLabel
    );
  });
  if (overdue > 0) {
    document.querySelectorAll('[data-route="/tasks"]').forEach((navItem) => {
      let anchor = navItem.querySelector('.nav-item__icon-wrap');
      if (!anchor) {
        const icon = navItem.querySelector('.nav-item__icon');
        anchor = document.createElement('span');
        anchor.className = 'nav-item__icon-wrap';
        if (icon) {
          icon.replaceWith(anchor);
          anchor.appendChild(icon);
        } else {
          navItem.prepend(anchor);
        }
      }
      const badge = document.createElement('span');
      badge.className = 'nav-badge';
      badge.setAttribute('aria-hidden', 'true');
      badge.textContent = String(overdue);
      anchor.appendChild(badge);
    });
  }
}

// --------------------------------------------------------
// Swipe-Gesten (Mobil: links = erledigt, rechts = bearbeiten)
// --------------------------------------------------------

const SWIPE_THRESHOLD    = 80;   // px - Mindestweg für Aktion
const SWIPE_MAX_VERT     = 12;   // px - vertikaler Bewegungs-Toleranzbereich (darunter: kein Scroll-Abbruch)
const SWIPE_LOCK_VERT    = 30;   // px - ab diesem Weg gilt es als Scroll (Swipe abgebrochen)

const SWIPE_HINT_KEY  = 'oikos:swipeHintSeen';
const SWIPE_HINT_MAX  = 3;
const RECENT_FILTERS_KEY = 'oikos:recentTaskFilters';
const RECENT_FILTERS_MAX = 3;
const SHOW_FUTURE_KEY = 'oikos:taskShowFuture';

function getRecentFilters() {
  try { return JSON.parse(localStorage.getItem(RECENT_FILTERS_KEY) ?? '[]'); } catch { return []; }
}

function saveRecentFilter(filters) {
  if (!filters.status && !filters.priority && !filters.assigned_to) return;
  const key = [filters.status, filters.priority, filters.assigned_to].join('|');
  const recent = getRecentFilters().filter((f) =>
    [f.status, f.priority, f.assigned_to].join('|') !== key
  );
  recent.unshift({ ...filters });
  try { localStorage.setItem(RECENT_FILTERS_KEY, JSON.stringify(recent.slice(0, RECENT_FILTERS_MAX))); } catch {}
}

function wireSwipeGestures(container) {
  const listEl = container.querySelector('#task-list');
  if (!listEl) return;

  listEl.querySelectorAll('.swipe-row').forEach((row) => {
    let startX = 0, startY = 0;
    let dx = 0;
    let locked = false;    // false = unentschieden, 'swipe' | 'scroll'
    let thresholdHit = false; // Haptic-Feedback am Threshold nur einmal
    const card = row.querySelector('.task-card');
    if (!card) return;

    function resetCard(animate = true) {
      card.style.transition = animate ? 'transform 0.25s ease' : '';
      card.style.transform  = '';
      row.classList.remove('swipe-row--swiping');
      // Reveal-Panels zurücksetzen
      row.querySelector('.swipe-reveal--done').style.opacity = '0';
      row.querySelector('.swipe-reveal--edit').style.opacity = '0';
    }

    row.addEventListener('touchstart', (e) => {
      // Geste ignorieren wenn Modal offen
      if (document.getElementById('shared-modal-overlay')) return;
      startX = e.touches[0].clientX;
      startY = e.touches[0].clientY;
      dx     = 0;
      locked = false;
      thresholdHit = false;
      card.style.transition = '';
    }, { passive: true });

    row.addEventListener('touchmove', (e) => {
      if (locked === 'scroll') return;

      const currentX = e.touches[0].clientX;
      const currentY = e.touches[0].clientY;
      dx = currentX - startX;
      const dy = Math.abs(currentY - startY);

      // Scroll-Richtung früh erkennen
      if (locked === false) {
        if (dy > SWIPE_MAX_VERT && Math.abs(dx) < dy) {
          locked = 'scroll';
          resetCard(false);
          return;
        }
        if (Math.abs(dx) > SWIPE_MAX_VERT) {
          locked = 'swipe';
        }
      }

      if (locked !== 'swipe') return;

      // Vertikalen Scroll verhindern sobald Swipe erkannt
      if (dy < SWIPE_LOCK_VERT) e.preventDefault();

      // Karte verschieben (gedämpft nach THRESHOLD)
      const dampened = dx > 0
        ? Math.min(dx, SWIPE_THRESHOLD + (dx - SWIPE_THRESHOLD) * 0.2)
        : Math.max(dx, -(SWIPE_THRESHOLD + (-dx - SWIPE_THRESHOLD) * 0.2));

      card.style.transform = `translateX(${dampened}px)`;
      row.classList.add('swipe-row--swiping');

      // Reveal-Panels einblenden (0 → 1 über Threshold)
      const progress = Math.min(Math.abs(dx) / SWIPE_THRESHOLD, 1);
      if (dx < 0) {
        row.querySelector('.swipe-reveal--done').style.opacity = String(progress);
        row.querySelector('.swipe-reveal--edit').style.opacity = '0';
      } else {
        row.querySelector('.swipe-reveal--edit').style.opacity = String(progress);
        row.querySelector('.swipe-reveal--done').style.opacity = '0';
      }

      // Haptic-Feedback beim Erreichen des Schwellwerts
      if (!thresholdHit && Math.abs(dx) >= SWIPE_THRESHOLD) {
        thresholdHit = true;
        vibrate(15);
      }
    }, { passive: false });

    row.addEventListener('touchend', async () => {
      if (locked !== 'swipe') { resetCard(false); return; }

      const taskId = row.dataset.swipeId;
      const status = row.dataset.swipeStatus;

      if (dx < -SWIPE_THRESHOLD) {
        // Swipe links → Status-Toggle (offen ↔ erledigt)
        card.style.transition = 'transform 0.2s ease';
        card.style.transform  = 'translateX(-110%)';
        vibrate(40);
        const capturedStatus = status;
        const nextStatus = capturedStatus === 'done' ? 'open' : 'done';
        setTimeout(async () => {
          resetCard(false);
          try {
            await toggleTaskStatus(taskId, capturedStatus);
            await loadTasks(container);
            window.oikos.showToast(
              t(nextStatus === 'done' ? 'tasks.swipedDoneToast' : 'tasks.swipedOpenToast'),
              'default',
              5000,
              async () => {
                try {
                  await toggleTaskStatus(taskId, nextStatus);
                  await loadTasks(container);
                } catch (err) {
                  window.oikos.showToast(err.message, 'danger');
                }
              },
            );
          } catch (err) {
            window.oikos.showToast(err.message, 'danger');
            await loadTasks(container);
          }
        }, 200);

      } else if (dx > SWIPE_THRESHOLD) {
        // Swipe rechts → Bearbeiten-Modal
        resetCard(true);
        vibrate(20);
        try {
          const [task, reminder] = await Promise.all([
            loadTaskForEdit(taskId),
            loadReminderForTask(taskId),
          ]);
          openTaskModal({ task, users: state.users, reminder }, container);
        } catch (err) {
          window.oikos.showToast(t('tasks.loadError'), 'danger');
        }

      } else {
        resetCard(true);
      }
    }, { passive: true });
  });
}

// --------------------------------------------------------
// Swipe-Affordance Hint (Long Loop)
// Zeigt den Nudge-Hinweis maximal 3x (gespeichert in localStorage).
// --------------------------------------------------------

function maybeShowSwipeHint(container) {
  if (window.innerWidth >= 1024) return; // Desktop: Swipe nicht relevant
  const count = parseInt(localStorage.getItem(SWIPE_HINT_KEY) ?? '0', 10);
  if (count >= SWIPE_HINT_MAX) return;

  const firstRow = container.querySelector('.swipe-row');
  if (!firstRow) return;

  firstRow.classList.add('swipe-row--hint');
  firstRow.addEventListener('animationend', () => {
    firstRow.classList.remove('swipe-row--hint');
  }, { once: true });

  localStorage.setItem(SWIPE_HINT_KEY, String(count + 1));
}

// --------------------------------------------------------
// Event-Verdrahtung
// --------------------------------------------------------

function wireFilterChips(container) {
  // Toggle-Button öffnet/schließt das Panel
  container.querySelector('#filter-toggle-btn')?.addEventListener('click', () => {
    state.filterPanelOpen = !state.filterPanelOpen;
    renderFilters(container);
  });

  // Alle Filter zurücksetzen
  container.querySelector('#filter-clear-all')?.addEventListener('click', async () => {
    state.filters = { status: '', priority: '', assigned_to: '' };
    renderFilters(container);
    await loadTasks(container);
  });

  // "Geplante anzeigen" Toggle
  container.querySelector('#filter-show-future')?.addEventListener('click', async () => {
    state.showFuture = !state.showFuture;
    try { localStorage.setItem(SHOW_FUTURE_KEY, state.showFuture ? '1' : '0'); } catch {}
    renderFilters(container);
    await loadTasks(container);
  });

  // Chip-Klicks (in Bar + Panel)
  container.querySelectorAll('[data-filter]').forEach((chip) => {
    chip.addEventListener('click', async () => {
      const filter = chip.dataset.filter;
      if (chip.classList.contains('filter-chip--active')) {
        state.filters[filter] = '';
      } else {
        state.filters[filter] = chip.dataset.value;
        saveRecentFilter(state.filters);
      }
      renderFilters(container);
      await loadTasks(container);
    });
  });

  // Recent-Filter-Chips anwenden
  container.querySelectorAll('[data-recent-filter]').forEach((chip) => {
    chip.addEventListener('click', async () => {
      try {
        const f = JSON.parse(chip.dataset.recentFilter);
        state.filters = { status: f.status || '', priority: f.priority || '', assigned_to: f.assigned_to || '' };
      } catch { return; }
      renderFilters(container);
      await loadTasks(container);
    });
  });
}

function wireViewToggle(container) {
  const toggle = container.querySelector('#view-toggle');
  if (!toggle) return;
  toggle.querySelectorAll('[data-view]').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.viewMode = btn.dataset.view;
      localStorage.setItem('oikos-tasks-view', state.viewMode);
      toggle.querySelectorAll('[data-view]').forEach((b) =>
        b.classList.toggle('group-toggle__btn--active', b.dataset.view === state.viewMode)
      );
      const groupToggle = container.querySelector('#group-mode-toggle');
      if (groupToggle) groupToggle.style.display = state.viewMode === 'list' ? '' : 'none';
      const bulkSelectBtn = container.querySelector('#btn-bulk-select');
      if (bulkSelectBtn) {
        bulkSelectBtn.style.display = state.viewMode === 'list' ? '' : 'none';
        if (state.viewMode === 'kanban') {
          state.bulkSelectMode = false;
          state.selectedTaskIds.clear();
          bulkSelectBtn.classList.remove('btn--active');
        }
      }
      // Skeleton-Flash: einen Frame Render-Feedback geben, dann Ansicht aufbauen
      const listEl = container.querySelector('#task-list');
      if (listEl) listEl.style.opacity = '0.4';
      requestAnimationFrame(() => {
        renderTaskList(container);
        updateBulkActionsBar(container);
        const el = container.querySelector('#task-list');
        if (el) { el.style.transition = 'opacity 0.15s'; el.style.opacity = ''; }
      });
    });
  });
}

function wireGroupToggle(container) {
  const toggle = container.querySelector('#group-mode-toggle');
  if (!toggle) return;
  toggle.querySelectorAll('.group-toggle__btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.groupMode = btn.dataset.mode;
      toggle.querySelectorAll('.group-toggle__btn').forEach((b) =>
        b.classList.toggle('group-toggle__btn--active', b.dataset.mode === state.groupMode)
      );
      renderTaskList(container);
    });
  });
}

function wireNewTaskBtn(container) {
  const handler = () => {
    openTaskModal({ users: state.users }, container);
  };
  container.querySelector('#btn-new-task')?.addEventListener('click', handler);
  container.querySelector('#fab-new-task')?.addEventListener('click', handler);
}

function updateBulkActionsBar(container) {
  const bar = container.querySelector('#bulk-actions-bar');
  const count = container.querySelector('#bulk-count');
  if (!bar) return;

  const selected = state.selectedTaskIds.size;
  const buttons = bar.querySelectorAll('button[id^="bulk-"]');

  bar.hidden = !state.bulkSelectMode;
  buttons.forEach((button) => {
    button.disabled = selected === 0;
  });

  if (count) {
    count.textContent = t('tasks.bulkSelectedCount', { count: selected });
  }
}

function wireBulkSelect(container) {
  const toggleBtn = container.querySelector('#btn-bulk-select');
  if (!toggleBtn) return;

  toggleBtn.addEventListener('click', () => {
    state.bulkSelectMode = !state.bulkSelectMode;
    if (!state.bulkSelectMode) {
      state.selectedTaskIds.clear();
    }
    toggleBtn.classList.toggle('btn--active', state.bulkSelectMode);
    loadTasks(container);
  });
}

function wireBulkCheckboxes(container) {
  const listEl = container.querySelector('#task-list');
  if (!listEl) return;

  listEl.addEventListener('change', (e) => {
    const checkbox = e.target.closest('.task-bulk-checkbox');
    if (!checkbox) return;

    const taskId = Number(checkbox.dataset.taskId);
    if (checkbox.checked) {
      state.selectedTaskIds.add(taskId);
    } else {
      state.selectedTaskIds.delete(taskId);
    }
    updateBulkActionsBar(container);
  });
}

function wireBulkActions(container) {
  const bar = container.querySelector('#bulk-actions-bar');
  if (!bar) return;

  bar.addEventListener('click', async (e) => {
    const btn = e.target.closest('button[id^="bulk-"]');
    if (!btn) return;

    const taskIds = [...state.selectedTaskIds];
    if (taskIds.length === 0) return;

    const action = btn.id;
    let confirm = true;
    if (action === 'bulk-delete') {
      confirm = window.confirm(t('tasks.bulkDeleteConfirm', { count: taskIds.length }));
    }
    if (!confirm) return;

    try {
      if (action === 'bulk-mark-done' || action === 'bulk-mark-open') {
        const status = btn.dataset.status;
        await Promise.all(taskIds.map(id => api.patch(`/tasks/${id}/status`, { status })));
        window.oikos.showToast(t('tasks.bulkStatusChanged'), 'success');
      } else if (action === 'bulk-archive') {
        await Promise.all(taskIds.map(id => api.patch(`/tasks/${id}/status`, { status: 'archived' })));
        window.oikos.showToast(t('tasks.bulkArchived'), 'success');
      } else if (action === 'bulk-delete') {
        await Promise.all(taskIds.map(id => api.delete(`/tasks/${id}`)));
        window.oikos.showToast(t('tasks.bulkDeleted'), 'success');
      }

      state.selectedTaskIds.clear();
      updateBulkActionsBar(container);
      await loadTasks(container);
    } catch (err) {
      window.oikos.showToast(err.message ?? t('common.errorGeneric'), 'danger');
    }
  });
}

function wireTaskList(container) {
  const listEl = container.querySelector('#task-list');
  if (!listEl) return;

  listEl.addEventListener('click', async (e) => {
    const target = e.target.closest('[data-action]');
    if (!target) return;
    const action = target.dataset.action;
    const id     = target.dataset.id;

    if (action === 'toggle-status') {
      const status = target.dataset.status;
      vibrate(15);
      target.classList.toggle('task-status-btn--done', status !== 'done');
      target.closest('.task-card')?.classList.toggle('task-card--done', status !== 'done');
      try {
        await toggleTaskStatus(id, status);
        await loadTasks(container);
      } catch (err) {
        window.oikos.showToast(err.message, 'danger');
        await loadTasks(container);
      }
    }

    if (action === 'toggle-subtasks') {
      const subtaskList = document.getElementById(`subtasks-${id}`);
      if (subtaskList) subtaskList.classList.toggle('subtask-list--visible');
    }

    if (action === 'toggle-subtask') {
      try {
        await toggleSubtaskStatus(id, target.dataset.status);
        await loadTasks(container);
      } catch (err) {
        window.oikos.showToast(err.message, 'danger');
      }
    }

    if (action === 'edit-task' || action === 'open-task') {
      try {
        const [task, reminder] = await Promise.all([
          loadTaskForEdit(id),
          loadReminderForTask(id),
        ]);
        openTaskModal({ task, users: state.users, reminder }, container);
      } catch (err) {
        window.oikos.showToast(t('tasks.loadError'), 'danger');
      }
    }

    if (action === 'archive-task') {
      try {
        await api.patch(`/tasks/${id}/status`, { status: 'archived' });
        window.oikos.showToast(t('tasks.archivedToast'), 'success');
        await loadTasks(container);
      } catch (err) {
        window.oikos.showToast(err.message, 'danger');
      }
    }

    if (action === 'add-subtask') {
      await handleAddSubtask(target.dataset.parent, container);
    }
  });
}

// --------------------------------------------------------
// Haupt-Render
// --------------------------------------------------------

export async function render(container, { user }) {
  // View-Mode: URL-Parameter > localStorage > Default 'list'
  const urlView = new URLSearchParams(window.location.search).get('view');
  const savedView = localStorage.getItem('oikos-tasks-view');
  state.viewMode = (urlView === 'kanban' || urlView === 'list') ? urlView
    : (savedView === 'kanban' || savedView === 'list') ? savedView
    : 'list';

  // showFuture aus localStorage wiederherstellen
  try { state.showFuture = localStorage.getItem(SHOW_FUTURE_KEY) === '1'; } catch {}

  const isKanban = state.viewMode === 'kanban';

  // Initiales Skeleton (all values are from i18n keys or hardcoded constants, no user data)
  container.replaceChildren();
  container.insertAdjacentHTML('beforeend', `
    <div class="tasks-page">
      <div class="tasks-toolbar">
        <h1 class="tasks-toolbar__title">${t('tasks.title')}</h1>
        <div class="tasks-toolbar__actions">
          <div class="group-toggle" id="group-mode-toggle" ${isKanban ? 'style="display:none"' : ''}>
            <button class="group-toggle__btn group-toggle__btn--active" data-mode="category">${t('tasks.categoryLabel')}</button>
            <button class="group-toggle__btn" data-mode="due">${t('tasks.dueDateLabel')}</button>
          </div>
          <div class="group-toggle" id="view-toggle">
            <button class="group-toggle__btn ${isKanban ? '' : 'group-toggle__btn--active'}" data-view="list"
                    title="${t('tasks.listView')}" aria-label="${t('tasks.listView')}">
              <i data-lucide="list" class="icon-md" aria-hidden="true"></i>
            </button>
            <button class="group-toggle__btn ${isKanban ? 'group-toggle__btn--active' : ''}" data-view="kanban"
                    title="${t('tasks.kanbanView')}" aria-label="${t('tasks.kanbanView')}">
              <i data-lucide="columns" class="icon-md" aria-hidden="true"></i>
            </button>
          </div>
          <button class="btn btn--ghost btn--icon" id="btn-bulk-select" ${isKanban ? 'style="display:none"' : ''}
                  title="${t('tasks.bulkSelect')}" aria-label="${t('tasks.bulkSelect')}">
            <i data-lucide="list-checks" class="icon-lg" aria-hidden="true"></i>
          </button>
          <button class="btn btn--primary" id="btn-new-task" style="gap:var(--space-1)">
            <i data-lucide="plus" class="icon-lg" aria-hidden="true"></i> ${t('tasks.newTask')}
          </button>
        </div>
      </div>

      <div class="tasks-body">
        <div class="tasks-filters" id="filter-bar"></div>
        <div class="filter-panel" id="filter-panel" hidden></div>
        <div class="bulk-actions-bar" id="bulk-actions-bar" hidden>
          <span class="bulk-actions-bar__count" id="bulk-count"></span>
          <div class="bulk-actions-bar__actions">
            <button class="btn btn--secondary btn--sm" id="bulk-mark-done" data-status="done">
              <i data-lucide="check" class="icon-md" aria-hidden="true"></i>
              ${t('tasks.bulkMarkDone')}
            </button>
            <button class="btn btn--secondary btn--sm" id="bulk-mark-open" data-status="open">
              <i data-lucide="rotate-ccw" class="icon-md" aria-hidden="true"></i>
              ${t('tasks.bulkMarkOpen')}
            </button>
            <button class="btn btn--secondary btn--sm" id="bulk-archive">
              <i data-lucide="archive" class="icon-md" aria-hidden="true"></i>
              ${t('tasks.bulkArchive')}
            </button>
            <button class="btn btn--danger btn--sm" id="bulk-delete">
              <i data-lucide="trash-2" class="icon-md" aria-hidden="true"></i>
              ${t('tasks.bulkDelete')}
            </button>
          </div>
        </div>

        <div id="task-list">
          ${[1,2,3].map(() => `
            <div class="widget-skeleton" style="margin-bottom:var(--space-2)">
              <div class="skeleton skeleton-line skeleton-line--medium" style="height:18px;margin-bottom:var(--space-3)"></div>
              <div class="skeleton skeleton-line skeleton-line--full" style="height:14px;margin-bottom:var(--space-2)"></div>
              <div class="skeleton skeleton-line skeleton-line--short" style="height:12px"></div>
            </div>`).join('')}
        </div>
        <button class="page-fab" id="fab-new-task" aria-label="${t('tasks.newTask')}">
          <i data-lucide="plus" class="icon-xl" aria-hidden="true"></i>
        </button>
      </div>
    </div>
  `);

  if (window.lucide) window.lucide.createIcons();

  // Daten laden (Filter-State aus vorheriger Session berücksichtigen)
  try {
    const params = new URLSearchParams();
    if (state.filters.status)      params.set('status',      state.filters.status);
    if (state.filters.priority)    params.set('priority',    state.filters.priority);
    if (state.filters.assigned_to) params.set('assigned_to', state.filters.assigned_to);
    if (state.showFuture)          params.set('include_future', '1');
    const query = params.toString() ? `?${params}` : '';

    const [tasksData, metaData] = await Promise.all([
      api.get(`/tasks${query}`),
      api.get('/tasks/meta/options'),
    ]);
    state.tasks = tasksData.data ?? [];
    state.users = metaData.users ?? [];
  } catch (err) {
    console.error('[Tasks] Ladefehler:', err.message);
    window.oikos.showToast(t('tasks.loadError'), 'danger');
    state.tasks = [];
    state.users = [];
  }

  // UI verdrahten
  wireViewToggle(container);
  wireGroupToggle(container);
  wireNewTaskBtn(container);
  wireTaskList(container);
  wireBulkSelect(container);
  wireBulkCheckboxes(container);
  wireBulkActions(container);
  renderFilters(container);
  renderTaskList(container);

  // Deep-Link: ?open=<id> öffnet direkt das Edit-Modal
  const openId = new URLSearchParams(window.location.search).get('open');
  if (openId) {
    try {
      const [task, reminder] = await Promise.all([
        loadTaskForEdit(openId),
        loadReminderForTask(openId),
      ]);
      openTaskModal({ task, users: state.users, reminder }, container);
    } catch { /* Task existiert nicht oder kein Zugriff */ }
  }
}
