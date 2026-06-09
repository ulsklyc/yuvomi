/**
 * Modul: Housekeeping
 * Zweck: Dashboard, chore management, reports, and housekeeping staff
 * Abhängigkeiten: /api.js, /i18n.js, /utils/html.js
 */

import { api } from '/api.js';
import { t, formatDate, formatTime, getLocale } from '/i18n.js';
import { esc } from '/utils/html.js';
import { openModal, closeModal, confirmModal } from '/components/modal.js';

const MAX_FILE_SIZE = 5 * 1024 * 1024;

function localDate(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function localDayParams() {
  return new URLSearchParams({
    local_date: localDate(),
    timezone_offset_minutes: String(new Date().getTimezoneOffset()),
  });
}

let state = {
  tab: 'dashboard',
  dashboard: null,
  tasks: [],
  reports: [],
  visitReport: null,
  templates: [],
  worker: null,
  workers: [],
  workerAvatar: undefined,
  selectedStaffId: null,
  staffLogMonth: localDate().slice(0, 7),
  staffVisits: [],
  currency: 'EUR',
};

function money(value) {
  return new Intl.NumberFormat(getLocale(), { style: 'currency', currency: state.currency }).format(Number(value || 0));
}

function initials(name = '') {
  return name.split(' ').map((part) => part[0]).join('').slice(0, 2).toUpperCase();
}

function urgencyLabel(status) {
  if (status === 'overdue') return t('housekeeping.overdue');
  if (status === 'today') return t('housekeeping.dueToday');
  return t('housekeeping.ok');
}

function scheduleLabel(value) {
  const map = {
    daily: t('housekeeping.scheduleDaily'),
    twice_monthly: t('housekeeping.scheduleTwiceMonthly'),
    monthly: t('housekeeping.scheduleMonthly'),
  };
  return map[value] || map.monthly;
}

function templateLabel(template, field) {
  if (!template?.key) return template?.[field] || '';
  const key = `housekeeping.taskTemplateData.${template.key}.${field}`;
  const translated = t(key);
  return translated === key ? template[field] : translated;
}

function visitTextPayload(worker, dateValue, dailyRate, extras) {
  const visitDate = dateValue || localDate();
  const total = Number(dailyRate || 0) + Number(extras || 0);
  const name = worker?.display_name || t('housekeeping.staff');
  return {
    event_title: t('housekeeping.calendarVisitTitle', { name }),
    payment_title: t('housekeeping.paymentTaskTitle', { name }),
    payment_description: t('housekeeping.paymentTaskDescription', {
      date: formatDate(visitDate),
      amount: money(total),
    }),
  };
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error(t('documents.fileReadError')));
    reader.readAsDataURL(file);
  });
}

async function loadStaffVisits(workerId = state.selectedStaffId, monthValue = state.staffLogMonth) {
  if (!workerId) {
    state.staffVisits = [];
    return;
  }
  const res = await api.get(`/housekeeping/visits?month=${encodeURIComponent(monthValue)}&worker_id=${encodeURIComponent(workerId)}`);
  state.staffVisits = res.data?.visits || [];
}

async function loadData() {
  const dayParams = localDayParams();
  const [dashboard, tasks, reports, templates, workers, prefs] = await Promise.all([
    api.get('/housekeeping/dashboard'),
    api.get('/housekeeping/decay-tasks'),
    api.get('/housekeeping/visits'),
    api.get('/housekeeping/task-templates'),
    api.get(`/housekeeping/workers?${dayParams.toString()}`),
    api.get('/preferences'),
  ]);
  state.dashboard = dashboard.data;
  state.tasks = tasks.data || [];
  state.visitReport = reports.data || { visits: [], totals: {} };
  state.reports = state.visitReport.visits || [];
  state.templates = templates.data || [];
  state.workers = workers.data || [];
  state.worker = state.workers[0] || null;
  state.currency = prefs.data?.currency ?? 'EUR';
}

function renderTabButton(tab, icon, label) {
  const current = state.tab === tab ? ' aria-current="page"' : '';
  return `
    <button class="housekeeping-tab sub-tab" type="button" data-housekeeping-tab="${esc(tab)}"${current}>
      <i class="sub-tab__icon" data-lucide="${esc(icon)}" aria-hidden="true"></i>
      <span class="sub-tab__label">${esc(label)}</span>
    </button>
  `;
}

function renderShell(container) {
  container.replaceChildren();
  container.insertAdjacentHTML('beforeend', `
    <section class="housekeeping-page" aria-labelledby="housekeeping-title">
      <header class="page-toolbar housekeeping-toolbar">
        <div class="page-toolbar__title" id="housekeeping-title">${esc(t('housekeeping.title'))}</div>
        <nav class="housekeeping-tabs" aria-label="${esc(t('housekeeping.bottomNav'))}">
          ${renderTabButton('dashboard', 'layout-dashboard', t('housekeeping.dashboard'))}
          ${renderTabButton('tasks', 'list-checks', t('housekeeping.tasks'))}
          ${renderTabButton('reports', 'file-text', t('housekeeping.reports'))}
          ${renderTabButton('staff', 'users-round', t('housekeeping.staff'))}
        </nav>
      </header>
      <div class="housekeeping-content" id="housekeeping-content"></div>
    </section>
  `);

  container.querySelectorAll('[data-housekeeping-tab]').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.tab = btn.dataset.housekeepingTab;
      renderCurrentTab(container);
    });
  });
  renderCurrentTab(container);
}

function renderCurrentTab(container) {
  const content = container.querySelector('#housekeeping-content');
  if (!content) return;
  content.replaceChildren();
  container.querySelectorAll('[data-housekeeping-tab]').forEach((btn) => {
    const active = btn.dataset.housekeepingTab === state.tab;
    btn.classList.toggle('sub-tab--active', active);
    if (active) btn.setAttribute('aria-current', 'page');
    else btn.removeAttribute('aria-current');
  });
  if (state.tab === 'tasks') renderTasks(content);
  else if (state.tab === 'reports') renderReports(content);
  else if (state.tab === 'staff') renderStaff(content);
  else renderDashboard(content);
  if (window.lucide) window.lucide.createIcons({ el: container });
}

async function toggleSession(container, workerId) {
  const worker = state.workers.find((item) => String(item.id) === String(workerId));
  const current = worker?.today_session;
  if (!state.workers.length) {
    window.oikos?.showToast(t('housekeeping.checkInDisabled'), 'warning');
    return;
  }
  if (!worker) return;
  try {
    if (current) {
      await api.post('/housekeeping/work-sessions/check-out', { worker_id: worker.id });
      window.oikos?.showToast(t('housekeeping.checkedOutToast'), 'success');
    } else {
      await api.post('/housekeeping/work-sessions/check-in', {
        worker_id: worker.id,
        daily_rate: worker.rate_type === 'hourly' ? 0 : (worker.daily_rate || 0),
        extras: 0,
        local_date: localDate(),
        timezone_offset_minutes: new Date().getTimezoneOffset(),
        ...visitTextPayload(worker, localDate(), worker.rate_type === 'hourly' ? 0 : (worker.daily_rate || 0), 0),
      });
      window.oikos?.showToast(t('housekeeping.checkedInToast'), 'success');
    }
    await loadData();
    renderShell(container);
  } catch (err) {
    window.oikos?.showToast(err.message, 'danger');
  }
}

function renderWorkerSummary() {
  if (!state.workers.length) {
    return `
      <section class="housekeeping-card housekeeping-worker-empty">
        <i data-lucide="user-plus" aria-hidden="true"></i>
        <div>
          <h2>${esc(t('housekeeping.noWorkerTitle'))}</h2>
          <p>${esc(t('housekeeping.noWorkerHint'))}</p>
          <button class="btn btn--primary housekeeping-worker-empty__cta" type="button" id="housekeeping-create-profile">
            <i data-lucide="plus" aria-hidden="true"></i>
            <span>${esc(t('housekeeping.setupProfileAction'))}</span>
          </button>
        </div>
      </section>
    `;
  }
  const rows = state.workers.map((worker) => {
    const checkedIn = !!worker.today_session;
    const session = worker.today_session;
    return `
    <section class="housekeeping-worker-strip">
      <div class="housekeeping-avatar" style="background:${esc(worker.avatar_color) || 'var(--module-housekeeping)'}">
        ${worker.avatar_data ? `<img src="${esc(worker.avatar_data)}" alt="${esc(worker.display_name)}">` : esc(initials(worker.display_name))}
      </div>
      <div>
        <strong>${esc(worker.display_name)}</strong>
        <span>${esc(checkedIn ? `${t('housekeeping.visitRecordedAt')} ${formatTime(session.check_in)}` : (worker.rate_type === 'hourly' ? `${money(worker.hourly_rate)}/${t('housekeeping.rateHourly')}` : `${money(worker.daily_rate)} · ${scheduleLabel(worker.payment_schedule)}`))}</span>
      </div>
      <button class="btn ${checkedIn ? 'btn--secondary' : 'btn--primary'} housekeeping-check-small" type="button"
              data-worker-check="${worker.id}" ${checkedIn ? 'disabled' : ''}>
        <i data-lucide="${checkedIn ? 'check' : 'log-in'}" aria-hidden="true"></i>
        <span>${esc(checkedIn ? t('housekeeping.checkedInToday') : t('housekeeping.checkIn'))}</span>
      </button>
    </section>
  `;
  }).join('');
  return `
    <div class="housekeeping-worker-stack">
      ${rows}
    </div>
  `;
}

function renderDashboard(content) {
  content.replaceChildren();
  const data = state.dashboard || {};
  if (!state.workers.length) {
    content.insertAdjacentHTML('beforeend', renderWorkerSummary());
    content.querySelector('#housekeeping-create-profile')?.addEventListener('click', () => {
      openStaffModal(null, content, { afterSave: () => renderDashboard(content) });
    });
    return;
  }
  const lastVisit = data.last_visit?.check_in ? `${formatDate(data.last_visit.check_in)} · ${formatTime(data.last_visit.check_in)}` : t('housekeeping.noVisits');
  const maxPayment = Math.max(1, ...(data.monthly_payments || []).map((row) => row.total));
  const bars = (data.monthly_payments || []).map((row) => {
    const height = Math.max(8, Math.round((row.total / maxPayment) * 88));
    return `
      <div class="housekeeping-chart__bar-wrap">
        <div class="housekeeping-chart__bar" style="height:${height}px" title="${esc(row.month)} ${esc(money(row.total))}"></div>
        <span>${esc(row.month.slice(5))}</span>
      </div>
    `;
  }).join('');

  const recentVisits = (state.reports || []).slice(0, 5);
  const recentRows = recentVisits.map((visit) => `
    <article class="housekeeping-staff-log-row">
      <div>
        <strong>${esc(formatDate(visit.check_in))}</strong>
        <span>${esc(visit.worker_name || t('housekeeping.staff'))} · ${esc(money(visit.total_amount))} · ${esc(visit.paid_at ? t('housekeeping.paymentPaid') : t('housekeeping.paymentPending'))}</span>
      </div>
      <div class="housekeeping-staff-log-row__actions">
        <button class="btn btn--secondary housekeeping-log-action" type="button" data-edit-visit="${esc(visit.id)}"
                aria-label="${esc(t('housekeeping.editVisit'))}">
          <i data-lucide="edit-2" aria-hidden="true"></i>
          <span>${esc(t('housekeeping.editVisit'))}</span>
        </button>
      </div>
    </article>
  `).join('');

  content.insertAdjacentHTML('beforeend', `
    ${renderWorkerSummary()}
    <section class="housekeeping-metrics">
      <article class="housekeeping-metric">
        <span>${esc(t('housekeeping.visitsThisMonth'))}</span>
        <strong>${esc(data.visits_this_month ?? 0)}</strong>
      </article>
      <article class="housekeeping-metric">
        <span>${esc(t('housekeeping.lastVisit'))}</span>
        <strong>${esc(lastVisit)}</strong>
      </article>
      <article class="housekeeping-metric">
        <span>${esc(t('housekeeping.pendingChores'))}</span>
        <strong>${esc(data.pending_tasks ?? 0)}</strong>
      </article>
      <article class="housekeeping-metric">
        <span>${esc(t('housekeeping.finishedChores'))}</span>
        <strong>${esc(data.finished_tasks_this_month ?? 0)}</strong>
      </article>
    </section>
    <section class="housekeeping-card">
      <div class="housekeeping-section-heading">
        <h2>${esc(t('housekeeping.payments'))}</h2>
        <span>${esc(t('housekeeping.pendingPayments'))}: ${esc(money(data.pending_payments || 0))}</span>
      </div>
      <div class="housekeeping-chart" aria-label="${esc(t('housekeeping.monthlyPayments'))}">
        ${bars || `<p class="housekeeping-muted">${esc(t('housekeeping.noPaymentData'))}</p>`}
      </div>
    </section>
    <section class="housekeeping-card">
      <div class="housekeeping-section-heading">
        <h2>${esc(t('housekeeping.recentVisits'))}</h2>
      </div>
      <div class="housekeeping-staff-log-list">
        ${recentRows || `<p class="housekeeping-muted">${esc(t('housekeeping.noVisits'))}</p>`}
      </div>
    </section>
  `);
  if (window.lucide) window.lucide.createIcons({ el: content });
  content.querySelectorAll('[data-worker-check]').forEach((btn) => {
    btn.addEventListener('click', () => toggleSession(document.querySelector('.page-transition') || document.body, btn.dataset.workerCheck));
  });
  content.querySelectorAll('[data-edit-visit]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const visit = (state.reports || []).find((v) => String(v.id) === btn.dataset.editVisit);
      if (visit) openVisitEditModal(visit, content, { onDone: renderDashboard });
    });
  });
}

async function createTask(payload, content) {
  try {
    await api.post('/housekeeping/decay-tasks', payload);
    window.oikos?.showToast(t('housekeeping.taskCreatedToast'), 'success');
    await loadData();
    renderTasks(content);
  } catch (err) {
    window.oikos?.showToast(err.message, 'danger');
  }
}

function renderTasks(content) {
  content.replaceChildren();
  const templateButtons = state.templates.map((template, index) => `
    <button class="housekeeping-template" type="button" data-template-index="${index}">
      <span>${esc(templateLabel(template, 'name'))}</span>
      <small>${esc(templateLabel(template, 'area'))} · ${esc(t('housekeeping.everyDays', { days: template.frequency_days }))}</small>
    </button>
  `).join('');
  const taskRows = state.tasks.map((task) => `
    <article class="housekeeping-task housekeeping-task--${esc(task.urgency_status)}">
      <button class="housekeeping-task__check" type="button" data-complete-task="${esc(task.id)}"
              aria-label="${esc(t('housekeeping.completeTask', { name: task.name }))}">
        <i data-lucide="check" aria-hidden="true"></i>
      </button>
      <div class="housekeeping-task__body">
        <h2>${esc(task.name)}</h2>
        <p>${esc(task.area)} · ${esc(t('housekeeping.everyDays', { days: task.frequency_days }))}</p>
        <span>${esc(urgencyLabel(task.urgency_status))}</span>
      </div>
      <div class="housekeeping-task__actions">
        ${task.last_completed ? `
          <button class="btn btn--secondary btn--icon" type="button" data-undo-task="${esc(task.id)}"
                  aria-label="${esc(t('housekeeping.undoTask'))}">
            <i data-lucide="rotate-ccw" aria-hidden="true"></i>
          </button>` : ''}
        <button class="btn btn--secondary btn--icon" type="button" data-edit-task="${esc(task.id)}"
                aria-label="${esc(t('housekeeping.editTask'))}">
          <i data-lucide="edit-2" aria-hidden="true"></i>
        </button>
        <button class="btn btn--danger-outline btn--icon" type="button" data-delete-task="${esc(task.id)}"
                aria-label="${esc(t('housekeeping.deleteTask'))}">
          <i data-lucide="trash-2" aria-hidden="true"></i>
        </button>
      </div>
    </article>
  `).join('');

  content.insertAdjacentHTML('beforeend', `
    <section class="housekeeping-card">
      <h2>${esc(t('housekeeping.taskTemplates'))}</h2>
      <div class="housekeeping-template-list">${templateButtons}</div>
    </section>
    <section class="housekeeping-card">
      <h2>${esc(t('housekeeping.addCustomTask'))}</h2>
      <form id="housekeeping-task-form" class="housekeeping-task-form">
        <div class="housekeeping-form-grid housekeeping-form-grid--wide">
          <label class="housekeeping-field">
            <span>${esc(t('housekeeping.taskName'))}</span>
            <input name="name" required maxlength="200" autocomplete="off">
          </label>
          <label class="housekeeping-field">
            <span>${esc(t('housekeeping.taskArea'))}</span>
            <input name="area" required maxlength="100" autocomplete="off">
          </label>
          <label class="housekeeping-field">
            <span>${esc(t('housekeeping.taskFrequency'))}</span>
            <input name="frequency_days" required inputmode="numeric" type="number" min="1" step="1" value="7">
          </label>
        </div>
        <button class="btn btn--primary housekeeping-form-submit" type="submit">
          <i data-lucide="plus" aria-hidden="true"></i>
          <span>${esc(t('housekeeping.createTask'))}</span>
        </button>
      </form>
    </section>
    <section class="housekeeping-task-list">
      ${taskRows || `
        <div class="empty-state">
          <i class="empty-state__icon" data-lucide="list-checks" aria-hidden="true"></i>
          <h2 class="empty-state__title">${esc(t('housekeeping.noTasks'))}</h2>
        </div>
      `}
    </section>
  `);

  content.querySelectorAll('[data-template-index]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const template = state.templates[Number(btn.dataset.templateIndex)];
      if (template) {
        createTask({
          name: templateLabel(template, 'name'),
          area: templateLabel(template, 'area'),
          frequency_days: template.frequency_days,
        }, content);
      }
    });
  });
  content.querySelector('#housekeeping-task-form')?.addEventListener('submit', (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const fields = form.elements;
    const frequencyDays = Number(fields.frequency_days.value);
    if (!fields.name.value.trim() || !fields.area.value.trim() || !Number.isInteger(frequencyDays) || frequencyDays < 1) return;
    createTask({
      name: fields.name.value.trim(),
      area: fields.area.value.trim(),
      frequency_days: frequencyDays,
    }, content);
  });
  content.querySelectorAll('[data-complete-task]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      try {
        await api.post(`/housekeeping/decay-tasks/${btn.dataset.completeTask}/complete`, {});
        window.oikos?.showToast(t('housekeeping.taskDoneToast'), 'success');
        await loadData();
        renderTasks(content);
      } catch (err) {
        window.oikos?.showToast(err.message, 'danger');
      }
    });
  });

  content.querySelectorAll('[data-undo-task]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      try {
        await api.patch(`/housekeeping/decay-tasks/${btn.dataset.undoTask}`, { last_completed: null });
        window.oikos?.showToast(t('housekeeping.taskUndoneToast'), 'success');
        await loadData();
        renderTasks(content);
      } catch (err) {
        window.oikos?.showToast(err.message, 'danger');
      }
    });
  });

  content.querySelectorAll('[data-delete-task]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const task = state.tasks.find((it) => String(it.id) === btn.dataset.deleteTask);
      if (!task) return;
      if (!window.confirm(t('housekeeping.deleteTaskConfirm', { name: task.name }))) return;
      try {
        await api.delete(`/housekeeping/decay-tasks/${task.id}`);
        window.oikos?.showToast(t('housekeeping.taskDeletedToast'), 'success');
        await loadData();
        renderTasks(content);
      } catch (err) {
        window.oikos?.showToast(err.message, 'danger');
      }
    });
  });

  content.querySelectorAll('[data-edit-task]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const task = state.tasks.find((it) => String(it.id) === btn.dataset.editTask);
      if (task) openTaskEditModal(task, content);
    });
  });
}

function renderReports(content) {
  content.replaceChildren();
  const totals = state.visitReport?.totals || {};
  const visits = state.reports || [];
  const rows = visits.map((visit) => {
    const paid = !!visit.paid_at;
    return `
    <article class="housekeeping-report-item housekeeping-report-item--visit">
      <div class="housekeeping-avatar" style="background:${esc(visit.worker_avatar_color) || 'var(--module-housekeeping)'}">
        ${visit.worker_avatar_data ? `<img src="${esc(visit.worker_avatar_data)}" alt="${esc(visit.worker_name || '')}">` : esc(initials(visit.worker_name || 'HK'))}
      </div>
      <div>
        <strong>${esc(visit.worker_name || t('housekeeping.staff'))}</strong>
        <span>${esc(formatDate(visit.check_in))} · ${esc(money(visit.total_amount))} · ${esc(paid ? t('housekeeping.paymentPaid') : t('housekeeping.paymentPending'))}</span>
      </div>
      <button class="btn btn--secondary btn--icon" type="button" data-visit-report="${visit.id}" aria-label="${esc(t('housekeeping.openVisitReport'))}">
        <i data-lucide="file-text" aria-hidden="true"></i>
      </button>
    </article>
  `;
  }).join('');

  content.insertAdjacentHTML('beforeend', `
    <section class="housekeeping-card">
      <div class="housekeeping-section-heading">
        <h2>${esc(t('housekeeping.visitReports'))}</h2>
        <span>${esc(state.visitReport?.month || '')}</span>
      </div>
      <section class="housekeeping-metrics housekeeping-metrics--compact">
        <article class="housekeeping-metric">
          <span>${esc(t('housekeeping.visitsThisMonth'))}</span>
          <strong>${esc(visits.length)}</strong>
        </article>
        <article class="housekeeping-metric">
          <span>${esc(t('housekeeping.pendingPayments'))}</span>
          <strong>${esc(money(totals.pending || 0))}</strong>
        </article>
        <article class="housekeeping-metric">
          <span>${esc(t('housekeeping.paymentPaid'))}</span>
          <strong>${esc(money(totals.paid || 0))}</strong>
        </article>
      </section>
    </section>
    <section class="housekeeping-reports" aria-label="${esc(t('housekeeping.recentReports'))}">
      ${rows || `<p class="housekeeping-muted">${esc(t('housekeeping.noVisitReports'))}</p>`}
    </section>
  `);

  content.querySelectorAll('[data-visit-report]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const visit = visits.find((item) => String(item.id) === btn.dataset.visitReport);
      if (visit) openVisitReportModal(visit);
    });
  });
}

function openVisitReportModal(visit) {
  const paid = !!visit.paid_at;
  openModal({
    title: t('housekeeping.visitReportDetails'),
    size: 'md',
    content: `
      <div class="housekeeping-report-modal">
        <div class="housekeeping-staff-row">
          <div class="housekeeping-avatar" style="background:${esc(visit.worker_avatar_color) || 'var(--module-housekeeping)'}">
            ${visit.worker_avatar_data ? `<img src="${esc(visit.worker_avatar_data)}" alt="${esc(visit.worker_name || '')}">` : esc(initials(visit.worker_name || 'HK'))}
          </div>
          <div>
            <strong>${esc(visit.worker_name || t('housekeeping.staff'))}</strong>
            <span>${esc(scheduleLabel(visit.payment_schedule))}</span>
          </div>
        </div>
        <dl class="housekeeping-report-details">
          <div><dt>${esc(t('housekeeping.lastVisit'))}</dt><dd>${esc(formatDate(visit.check_in))} · ${esc(formatTime(visit.check_in))}</dd></div>
          <div><dt>${esc(t('housekeeping.dailyRate'))}</dt><dd>${esc(money(visit.daily_rate))}</dd></div>
          <div><dt>${esc(t('housekeeping.extras'))}</dt><dd>${esc(money(visit.extras))}</dd></div>
          <div><dt>${esc(t('housekeeping.totalPayment'))}</dt><dd>${esc(money(visit.total_amount))}</dd></div>
          <div><dt>${esc(t('housekeeping.paymentStatus'))}</dt><dd>${esc(paid ? t('housekeeping.paymentPaid') : t('housekeeping.paymentPending'))}</dd></div>
          <div><dt>${esc(t('housekeeping.paymentTask'))}</dt><dd>${esc(visit.payment_task_id ? `#${visit.payment_task_id}` : t('housekeeping.notAvailable'))}</dd></div>
          <div><dt>${esc(t('housekeeping.calendarEvent'))}</dt><dd>${esc(visit.calendar_event_id ? `#${visit.calendar_event_id}` : t('housekeeping.notAvailable'))}</dd></div>
        </dl>
      </div>
    `,
  });
}

function renderStaff(content) {
  content.replaceChildren();
  const workerRows = state.workers.map((item) => `
    <article class="housekeeping-staff-row ${String(state.selectedStaffId || '') === String(item.id) ? 'housekeeping-staff-row--active' : ''}"
             data-select-worker="${item.id}" role="button" tabindex="0">
      <div class="housekeeping-avatar" style="background:${esc(item.avatar_color) || 'var(--module-housekeeping)'}">
        ${item.avatar_data ? `<img src="${esc(item.avatar_data)}" alt="${esc(item.display_name)}">` : esc(initials(item.display_name))}
      </div>
      <div>
        <strong>${esc(item.display_name)}</strong>
        <span>${esc(item.phone || item.email || '')}</span>
      </div>
      <button class="btn btn--secondary btn--icon" type="button" data-edit-worker="${item.id}" aria-label="${esc(t('common.edit'))}">
        <i data-lucide="edit-2" aria-hidden="true"></i>
      </button>
    </article>
  `).join('');
  content.insertAdjacentHTML('beforeend', `
    <section class="housekeeping-card">
      <div class="housekeeping-section-heading">
        <h2>${esc(t('housekeeping.staffTitle'))}</h2>
        <button class="btn btn--secondary" type="button" id="housekeeping-new-worker">
          <i data-lucide="plus" aria-hidden="true"></i>
          <span>${esc(t('housekeeping.addWorker'))}</span>
        </button>
      </div>
      <div class="housekeeping-staff-list">
        ${workerRows || `<p class="housekeeping-muted">${esc(t('housekeeping.noWorkers'))}</p>`}
      </div>
    </section>
    ${state.selectedStaffId ? renderStaffVisitLog() : ''}
  `);

  content.querySelector('#housekeeping-new-worker')?.addEventListener('click', () => {
    openStaffModal(null, content);
  });
  content.querySelectorAll('[data-select-worker]').forEach((row) => {
    const select = async () => {
      state.selectedStaffId = row.dataset.selectWorker;
      try {
        await loadStaffVisits();
        renderStaff(content);
      } catch (err) {
        window.oikos?.showToast(err.message, 'danger');
      }
    };
    row.addEventListener('click', (event) => {
      if (event.target.closest('[data-edit-worker]')) return;
      select();
    });
    row.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      select();
    });
  });
  content.querySelectorAll('[data-edit-worker]').forEach((btn) => {
    btn.addEventListener('click', (event) => {
      event.stopPropagation();
      const worker = state.workers.find((item) => String(item.id) === btn.dataset.editWorker) || null;
      openStaffModal(worker, content);
    });
  });
  content.querySelector('#housekeeping-staff-month')?.addEventListener('change', async (event) => {
    state.staffLogMonth = event.currentTarget.value || localDate().slice(0, 7);
    try {
      await loadStaffVisits();
      renderStaff(content);
    } catch (err) {
      window.oikos?.showToast(err.message, 'danger');
    }
  });
  content.querySelectorAll('[data-edit-visit]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const visit = state.staffVisits.find((item) => String(item.id) === btn.dataset.editVisit);
      if (visit) openVisitEditModal(visit, content);
    });
  });
  content.querySelectorAll('[data-pay-visit]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const visit = state.staffVisits.find((item) => String(item.id) === btn.dataset.payVisit);
      if (!visit) return;
      try {
        await api.post(`/housekeeping/visits/${visit.id}/pay`, {});
        window.oikos?.showToast(t('housekeeping.visitPaidToast'), 'success');
        await loadData();
        await loadStaffVisits();
        renderStaff(content);
      } catch (err) {
        window.oikos?.showToast(err.message, 'danger');
      }
    });
  });
  content.querySelectorAll('[data-delete-visit]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const visit = state.staffVisits.find((item) => String(item.id) === btn.dataset.deleteVisit);
      if (!visit) return;
      if (!await confirmModal(t('housekeeping.deleteVisitConfirm'), { danger: true, confirmLabel: t('common.delete') })) return;
      try {
        await api.delete(`/housekeeping/visits/${visit.id}`);
        window.oikos?.showToast(t('housekeeping.visitDeletedToast'), 'success');
        await loadData();
        await loadStaffVisits();
        renderStaff(content);
      } catch (err) {
        window.oikos?.showToast(err.message, 'danger');
      }
    });
  });
  if (window.lucide) window.lucide.createIcons({ el: content });
}

function renderStaffVisitLog() {
  const worker = state.workers.find((item) => String(item.id) === String(state.selectedStaffId));
  if (!worker) return '';
  const rows = state.staffVisits.map((visit) => {
    const paid = !!visit.paid_at;
    return `
      <article class="housekeeping-staff-log-row">
        <div>
          <strong>${esc(formatDate(visit.check_in))}</strong>
          <span>${esc(money(visit.total_amount))} · ${esc(paid ? t('housekeeping.paymentPaid') : t('housekeeping.paymentPending'))}</span>
        </div>
        <div class="housekeeping-staff-log-row__actions">
          <button class="btn btn--secondary housekeeping-log-action" type="button" data-pay-visit="${visit.id}" ${paid ? 'disabled' : ''}
                  aria-label="${esc(t('housekeeping.markPaid'))}">
            <i data-lucide="badge-dollar-sign" aria-hidden="true"></i>
            <span>${esc(paid ? t('housekeeping.paymentPaid') : t('housekeeping.markPaid'))}</span>
          </button>
          <button class="btn btn--secondary housekeeping-log-action" type="button" data-edit-visit="${visit.id}" aria-label="${esc(t('housekeeping.editVisit'))}">
            <i data-lucide="edit-2" aria-hidden="true"></i>
            <span>${esc(t('housekeeping.editVisit'))}</span>
          </button>
          <button class="btn btn--danger-outline housekeeping-log-action" type="button" data-delete-visit="${visit.id}" aria-label="${esc(t('housekeeping.deleteVisit'))}">
            <i data-lucide="trash-2" aria-hidden="true"></i>
            <span>${esc(t('housekeeping.deleteVisit'))}</span>
          </button>
        </div>
      </article>
    `;
  }).join('');
  return `
    <section class="housekeeping-card housekeeping-staff-log">
      <div class="housekeeping-section-heading">
        <div>
          <h2>${esc(t('housekeeping.staffLogTitle', { name: worker.display_name }))}</h2>
          <span>${esc(t('housekeeping.staffLogHint'))}</span>
        </div>
        <label class="housekeeping-field housekeeping-field--inline">
          <span>${esc(t('housekeeping.filterMonth'))}</span>
          <input id="housekeeping-staff-month" type="month" value="${esc(state.staffLogMonth)}">
        </label>
      </div>
      <div class="housekeeping-staff-log-list">
        ${rows || `<p class="housekeeping-muted">${esc(t('housekeeping.noVisitReports'))}</p>`}
      </div>
    </section>
  `;
}

function openTaskEditModal(task, content) {
  openModal({
    title: t('housekeeping.editTask'),
    size: 'md',
    content: `
      <form id="housekeeping-task-edit-form" class="housekeeping-worker-form">
        <label class="housekeeping-field">
          <span>${esc(t('housekeeping.taskName'))}</span>
          <input name="name" required maxlength="200" value="${esc(task.name)}">
        </label>
        <label class="housekeeping-field">
          <span>${esc(t('housekeeping.taskArea'))}</span>
          <input name="area" required maxlength="100" value="${esc(task.area)}">
        </label>
        <label class="housekeeping-field">
          <span>${esc(t('housekeeping.taskFrequency'))}</span>
          <input name="frequency_days" required inputmode="numeric" type="number" min="1" step="1" value="${esc(task.frequency_days)}">
        </label>
        <button class="btn btn--primary housekeeping-form-submit" type="submit">
          <i data-lucide="save" aria-hidden="true"></i>
          <span>${esc(t('common.save'))}</span>
        </button>
      </form>
    `,
    onSave: (panel) => {
      panel.querySelector('#housekeeping-task-edit-form')?.addEventListener('submit', async (event) => {
        event.preventDefault();
        const fields = event.currentTarget.elements;
        const frequencyDays = Number(fields.frequency_days.value);
        if (!fields.name.value.trim() || !fields.area.value.trim() || !Number.isInteger(frequencyDays) || frequencyDays < 1) return;
        try {
          await api.patch(`/housekeeping/decay-tasks/${task.id}`, {
            name: fields.name.value.trim(),
            area: fields.area.value.trim(),
            frequency_days: frequencyDays,
          });
          window.oikos?.showToast(t('housekeeping.taskUpdatedToast'), 'success');
          await loadData();
          closeModal({ force: true });
          renderTasks(content);
        } catch (err) {
          window.oikos?.showToast(err.message, 'danger');
        }
      });
    },
  });
}

function openVisitEditModal(visit, content, { onDone } = {}) {
  const worker = state.workers.find((item) => String(item.id) === String(visit.worker_id)) || null;
  openModal({
    title: t('housekeeping.editVisit'),
    size: 'md',
    content: `
      <form id="housekeeping-visit-form" class="housekeeping-worker-form">
        <label class="housekeeping-field">
          <span>${esc(t('housekeeping.visitDate'))}</span>
          <input name="date" type="date" required value="${esc(visit.check_in.slice(0, 10))}">
        </label>
        <div class="housekeeping-form-grid">
          ${visit.rate_type === 'hourly' ? `
            <label class="housekeeping-field">
              <span>${esc(t('housekeeping.minutesWorked'))}</span>
              <input name="minutes_worked" type="number" min="0" step="1" inputmode="numeric" id="hk-visit-minutes" value="${esc(visit.minutes_worked ?? 0)}">
            </label>
            <label class="housekeeping-field">
              <span>${esc(t('housekeeping.computedAmount'))}</span>
              <output id="hk-visit-computed">${esc(money(visit.daily_rate ?? 0))}</output>
            </label>
          ` : `
            <label class="housekeeping-field">
              <span>${esc(t('housekeeping.dailyRate'))}</span>
              <input name="daily_rate" type="number" min="0" step="0.01" inputmode="decimal" value="${esc(visit.daily_rate ?? 0)}">
            </label>
          `}
          <label class="housekeeping-field">
            <span>${esc(t('housekeeping.extras'))}</span>
            <input name="extras" type="number" min="0" step="0.01" inputmode="decimal" value="${esc(visit.extras ?? 0)}">
          </label>
        </div>
        <label class="document-dropzone" id="housekeeping-receipt-dropzone" for="housekeeping-receipt-file">
          <input class="sr-only" id="housekeeping-receipt-file" type="file" accept="image/png,image/jpeg,image/webp,application/pdf,text/plain,text/csv">
          <span class="document-dropzone__icon">
            <i data-lucide="receipt" aria-hidden="true"></i>
          </span>
          <span class="document-dropzone__title">${esc(t('housekeeping.receiptUploadTitle'))}</span>
          <span class="document-dropzone__hint">${esc(t('housekeeping.receiptUploadHint'))}</span>
          <span class="document-dropzone__file" id="housekeeping-receipt-selected" ${visit.receipt_document_name ? '' : 'hidden'}>
            ${esc(visit.receipt_document_name || '')}
          </span>
        </label>
        <button class="btn btn--primary housekeeping-form-submit" type="submit">
          <i data-lucide="save" aria-hidden="true"></i>
          <span>${esc(t('common.save'))}</span>
        </button>
      </form>
    `,
    onSave: (panel) => {
      panel.querySelector('#housekeeping-visit-form')?.addEventListener('submit', async (event) => {
        event.preventDefault();
        const form = event.currentTarget;
        const fields = form.elements;
        const dateValue = fields.date.value;
        const minutesWorked = visit.rate_type === 'hourly'
          ? Number(fields.minutes_worked?.value || 0)
          : null;
        const dailyRate = visit.rate_type === 'hourly'
          ? null
          : Number(fields.daily_rate.value || 0);
        const extras = Number(fields.extras.value || 0);
        let receiptDocumentId = visit.receipt_document_id || null;
        try {
          const file = panel.querySelector('#housekeeping-receipt-file')?.files?.[0];
          if (file) {
            if (file.size > MAX_FILE_SIZE) throw new Error(t('documents.fileTooLarge'));
            const receipt = await api.post('/documents', {
              name: t('housekeeping.receiptDocumentName', {
                name: worker?.display_name || t('housekeeping.staff'),
                date: formatDate(dateValue),
              }),
              description: t('housekeeping.receiptDocumentDescription', {
                name: worker?.display_name || t('housekeeping.staff'),
                date: formatDate(dateValue),
              }),
              category: 'finance',
              visibility: 'family',
              status: 'active',
              allowed_member_ids: [],
              original_name: file.name,
              content_data: await readFileAsDataUrl(file),
              folder_name: t('documents.housekeepingFolder'),
            });
            receiptDocumentId = receipt.data?.id || receiptDocumentId;
          }
          await api.put(`/housekeeping/visits/${visit.id}`, {
            date: dateValue,
            ...(visit.rate_type === 'hourly'
              ? { minutes_worked: minutesWorked }
              : { daily_rate: dailyRate }),
            extras,
            receipt_document_id: receiptDocumentId,
            ...visitTextPayload(worker, dateValue, dailyRate ?? visit.daily_rate, extras),
          });
          window.oikos?.showToast(t('housekeeping.visitSavedToast'), 'success');
          await loadData();
          state.staffLogMonth = dateValue.slice(0, 7);
          await loadStaffVisits();
          closeModal({ force: true });
          (onDone || renderStaff)(content);
        } catch (err) {
          window.oikos?.showToast(err.message, 'danger');
        }
      });
    },
  });
  const panel = document.querySelector('.modal-panel');
  if (visit.rate_type === 'hourly') {
    const minutesInput = panel?.querySelector('#hk-visit-minutes');
    const computedOutput = panel?.querySelector('#hk-visit-computed');
    function updateComputed() {
      if (!minutesInput || !computedOutput) return;
      const mins = Math.max(0, Number(minutesInput.value) || 0);
      const rounded = Math.round(mins / 15) * 15;
      const amount = (rounded / 60) * (Number(visit.hourly_rate) || 0);
      const fmt = new Intl.NumberFormat(getLocale(), { style: 'currency', currency: state.currency || 'EUR' });
      computedOutput.textContent = fmt.format(amount);
    }
    minutesInput?.addEventListener('input', updateComputed);
    updateComputed();
  }
  const receiptInput = panel?.querySelector('#housekeeping-receipt-file');
  const receiptSelected = panel?.querySelector('#housekeeping-receipt-selected');
  receiptInput?.addEventListener('change', () => {
    const file = receiptInput.files?.[0];
    if (!receiptSelected) return;
    receiptSelected.hidden = !file && !visit.receipt_document_name;
    receiptSelected.textContent = file
      ? t('documents.selectedFileLabel', { name: file.name })
      : (visit.receipt_document_name || '');
  });
  if (window.lucide) window.lucide.createIcons({ el: panel });
}

function openStaffModal(worker, content, options = {}) {
  const item = worker || {};
  state.workerAvatar = item.avatar_data ?? null;
  openModal({
    title: item.id ? t('housekeeping.editWorker') : t('housekeeping.addWorker'),
    size: 'lg',
    content: `
      <form id="housekeeping-worker-form" class="housekeeping-worker-form">
        <input type="hidden" name="id" value="${esc(item.id || '')}">
        <div class="housekeeping-profile-editor">
          <button class="housekeeping-avatar housekeeping-avatar--lg" type="button" id="housekeeping-avatar-btn"
                  style="background:${esc(item.avatar_color) || 'var(--module-housekeeping)'}" aria-label="${esc(t('housekeeping.profilePicture'))}">
            ${item.avatar_data ? `<img src="${esc(item.avatar_data)}" alt="${esc(item.display_name || '')}">` : esc(initials(item.display_name || 'HK'))}
          </button>
          <input class="sr-only" type="file" id="housekeeping-avatar-file" accept="image/png,image/jpeg,image/webp">
          <div class="housekeeping-profile-editor__fields">
            <label class="housekeeping-field">
              <span>${esc(t('housekeeping.workerName'))}</span>
              <input name="display_name" required maxlength="128" value="${esc(item.display_name || '')}">
            </label>
            <label class="housekeeping-field">
              <span>${esc(t('housekeeping.workerUsername'))}</span>
              <input name="username" maxlength="64" autocomplete="off" value="${esc(item.username || '')}">
            </label>
          </div>
        </div>
        <div class="housekeeping-form-grid housekeeping-form-grid--wide">
          <label class="housekeeping-field">
            <span>${esc(t('housekeeping.workerPhone'))}</span>
            <input name="phone" type="tel" autocomplete="tel" value="${esc(item.phone || '')}">
          </label>
          <label class="housekeeping-field">
            <span>${esc(t('housekeeping.workerEmail'))}</span>
            <input name="email" type="email" autocomplete="email" value="${esc(item.email || '')}">
          </label>
          <label class="housekeeping-field">
            <span>${esc(t('housekeeping.workerBirthDate'))}</span>
            <input name="birth_date" type="date" value="${esc(item.birth_date || '')}">
          </label>
          <label class="housekeeping-field">
            <span>${esc(t('housekeeping.rateType'))}</span>
            <select name="rate_type">
              <option value="daily"${(!item.rate_type || item.rate_type === 'daily') ? ' selected' : ''}>${esc(t('housekeeping.rateDaily'))}</option>
              <option value="hourly"${item.rate_type === 'hourly' ? ' selected' : ''}>${esc(t('housekeeping.rateHourly'))}</option>
            </select>
          </label>
          <label class="housekeeping-field" id="housekeeping-field-daily-rate">
            <span>${esc(t('housekeeping.dailyRate'))}</span>
            <input name="daily_rate" type="number" min="0" step="0.01" inputmode="decimal" value="${esc(item.daily_rate ?? 0)}">
          </label>
          <label class="housekeeping-field" id="housekeeping-field-hourly-rate"${(!item.rate_type || item.rate_type === 'daily') ? ' hidden' : ''}>
            <span>${esc(t('housekeeping.hourlyRate'))}</span>
            <input name="hourly_rate" type="number" min="0" step="0.01" inputmode="decimal" value="${esc(item.hourly_rate ?? 0)}">
          </label>
          <label class="housekeeping-field housekeeping-field--color">
            <span>${esc(t('housekeeping.calendarColor'))}</span>
            <input name="calendar_color" type="color" value="${esc(item.calendar_color || '#7C3AED')}">
          </label>
          <label class="housekeeping-field">
            <span>${esc(t('housekeeping.paymentSchedule'))}</span>
            <select name="payment_schedule">
              <option value="daily"${item.payment_schedule === 'daily' ? ' selected' : ''}>${esc(t('housekeeping.scheduleDaily'))}</option>
              <option value="twice_monthly"${item.payment_schedule === 'twice_monthly' ? ' selected' : ''}>${esc(t('housekeeping.scheduleTwiceMonthly'))}</option>
              <option value="monthly"${!item.payment_schedule || item.payment_schedule === 'monthly' ? ' selected' : ''}>${esc(t('housekeeping.scheduleMonthly'))}</option>
            </select>
          </label>
          <label class="housekeeping-field housekeeping-field--color">
            <span>${esc(t('housekeeping.profileColor'))}</span>
            <input name="avatar_color" type="color" value="${esc(item.avatar_color || '#7C3AED')}">
          </label>
        </div>
        <label class="housekeeping-field">
          <span>${esc(t('housekeeping.workerNotes'))}</span>
          <textarea name="notes" rows="3" maxlength="5000">${esc(item.notes || '')}</textarea>
        </label>
        <button class="btn btn--primary housekeeping-form-submit" type="submit">
          <i data-lucide="save" aria-hidden="true"></i>
          <span>${esc(t('common.save'))}</span>
        </button>
      </form>
    `,
    onSave: (panel) => {
      panel.querySelector('#housekeeping-worker-form')?.addEventListener('submit', async (event) => {
        event.preventDefault();
        const form = event.currentTarget;
        const fields = form.elements;
        try {
          await api.post('/housekeeping/worker', {
            id: fields.id.value || null,
            display_name: fields.display_name.value.trim(),
            username: fields.username.value.trim() || null,
            phone: fields.phone.value.trim() || null,
            email: fields.email.value.trim() || null,
            birth_date: fields.birth_date.value || null,
            daily_rate: Number(fields.daily_rate.value || 0),
            rate_type: fields.rate_type.value,
            hourly_rate: Number(fields.hourly_rate?.value || 0),
            payment_schedule: fields.payment_schedule.value,
            calendar_color: fields.calendar_color.value,
            avatar_color: fields.avatar_color.value,
            avatar_data: state.workerAvatar,
            notes: fields.notes.value.trim() || null,
          });
          window.oikos?.showToast(t('housekeeping.workerSavedToast'), 'success');
          await loadData();
          closeModal({ force: true });
          if (typeof options.afterSave === 'function') options.afterSave();
          else renderStaff(content);
        } catch (err) {
          window.oikos?.showToast(err.message, 'danger');
        }
      });
    },
  });

  const panel = document.querySelector('.modal-panel');

  // Wire rate_type toggle to show/hide daily/hourly rate fields
  const rateTypeSelect = panel?.querySelector('[name="rate_type"]');
  const dailyRateField = panel?.querySelector('#housekeeping-field-daily-rate');
  const hourlyRateField = panel?.querySelector('#housekeeping-field-hourly-rate');
  function updateRateFields() {
    const isHourly = rateTypeSelect?.value === 'hourly';
    if (dailyRateField) dailyRateField.hidden = isHourly;
    if (hourlyRateField) hourlyRateField.hidden = !isHourly;
  }
  rateTypeSelect?.addEventListener('change', updateRateFields);

  const avatarFile = panel?.querySelector('#housekeeping-avatar-file');
  const avatarButton = panel?.querySelector('#housekeeping-avatar-btn');
  avatarButton?.addEventListener('click', () => avatarFile?.click());
  avatarFile?.addEventListener('change', async () => {
    const file = avatarFile.files?.[0];
    if (!file) return;
    try {
      const dataUrl = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.addEventListener('load', () => resolve(String(reader.result || '')));
        reader.addEventListener('error', () => reject(new Error()));
        reader.readAsDataURL(file);
      });
      const { openCropDialog } = await import('/utils/avatar-crop.js');
      const cropped = await openCropDialog(dataUrl);
      if (!cropped) { avatarFile.value = ''; return; }
      state.workerAvatar = cropped;
      avatarButton.replaceChildren();
      avatarButton.insertAdjacentHTML('beforeend', `<img src="${esc(state.workerAvatar)}" alt="">`);
    } catch {
      avatarFile.value = '';
    }
  });
  if (window.lucide) window.lucide.createIcons({ el: panel });
}

export async function render(container) {
  container.replaceChildren();
  container.insertAdjacentHTML('beforeend', `
    <section class="housekeeping-page housekeeping-page--loading">
      <div class="housekeeping-loading">${esc(t('common.loading'))}</div>
    </section>
  `);
  try {
    await loadData();
    renderShell(container);
    const editVisitId = new URLSearchParams(window.location.search).get('editVisit');
    if (editVisitId) {
      try {
        const res = await api.get(`/housekeeping/visits/${editVisitId}`);
        const visit = res.data;
        if (visit) {
          const content = container.querySelector('#housekeeping-content') || container;
          openVisitEditModal(visit, content);
        }
      } catch {
        // visit not found or unauthorized — silently ignore
      }
    }
  } catch (err) {
    container.replaceChildren();
    container.insertAdjacentHTML('beforeend', `
      <section class="housekeeping-page">
        <div class="empty-state">
          <div class="empty-state__title">${esc(t('common.errorOccurred'))}</div>
          <div class="empty-state__description">${esc(err.message)}</div>
        </div>
      </section>
    `);
  }
}
