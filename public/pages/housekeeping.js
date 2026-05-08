/**
 * Modul: Housekeeping
 * Zweck: Dashboard, chore management, reports, and housekeeping staff
 * Abhängigkeiten: /api.js, /i18n.js, /utils/html.js
 */

import { api } from '/api.js';
import { t, formatDate, formatTime } from '/i18n.js';
import { esc } from '/utils/html.js';
import { openModal, closeModal, confirmModal } from '/components/modal.js';

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
  staffLogMonth: new Date().toISOString().slice(0, 7),
  staffVisits: [],
};

function money(value) {
  return new Intl.NumberFormat(undefined, { style: 'currency', currency: 'BRL' }).format(Number(value || 0));
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

function visitTextPayload(worker, dateValue, dailyRate, extras) {
  const visitDate = dateValue || new Date().toISOString().slice(0, 10);
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

async function loadStaffVisits(workerId = state.selectedStaffId, monthValue = state.staffLogMonth) {
  if (!workerId) {
    state.staffVisits = [];
    return;
  }
  const res = await api.get(`/housekeeping/visits?month=${encodeURIComponent(monthValue)}&worker_id=${encodeURIComponent(workerId)}`);
  state.staffVisits = res.data?.visits || [];
}

async function loadData() {
  const [dashboard, tasks, reports, templates, workers] = await Promise.all([
    api.get('/housekeeping/dashboard'),
    api.get('/housekeeping/decay-tasks'),
    api.get('/housekeeping/visits'),
    api.get('/housekeeping/task-templates'),
    api.get('/housekeeping/workers'),
  ]);
  state.dashboard = dashboard.data;
  state.tasks = tasks.data || [];
  state.visitReport = reports.data || { visits: [], totals: {} };
  state.reports = state.visitReport.visits || [];
  state.templates = templates.data || [];
  state.workers = workers.data || [];
  state.worker = state.workers[0] || null;
}

function renderTabButton(tab, icon, label) {
  const current = state.tab === tab ? ' aria-current="page"' : '';
  return `
    <button class="housekeeping-tab" type="button" data-housekeeping-tab="${esc(tab)}"${current}>
      <i data-lucide="${esc(icon)}" aria-hidden="true"></i>
      <span>${esc(label)}</span>
    </button>
  `;
}

function renderShell(container) {
  const hasWorker = state.workers.length > 0;
  container.replaceChildren();
  container.insertAdjacentHTML('beforeend', `
    <section class="housekeeping-page" aria-labelledby="housekeeping-title">
      <header class="housekeeping-toolbar">
        <div class="housekeeping-toolbar__title" id="housekeeping-title">${esc(t('housekeeping.title'))}</div>
        <button class="btn btn--secondary housekeeping-check-small" type="button" disabled ${hasWorker ? 'hidden' : ''}>
          <i data-lucide="log-in" aria-hidden="true"></i>
          <span>${esc(t('housekeeping.checkIn'))}</span>
        </button>
      </header>
      <nav class="housekeeping-tabs" aria-label="${esc(t('housekeeping.bottomNav'))}">
        ${renderTabButton('dashboard', 'layout-dashboard', t('housekeeping.dashboard'))}
        ${renderTabButton('tasks', 'list-checks', t('housekeeping.tasks'))}
        ${renderTabButton('reports', 'file-text', t('housekeeping.reports'))}
        ${renderTabButton('staff', 'users-round', t('housekeeping.staff'))}
      </nav>
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
    if (btn.dataset.housekeepingTab === state.tab) btn.setAttribute('aria-current', 'page');
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
  const current = worker?.today_session || worker?.current_session;
  if (!state.workers.length) {
    window.oikos?.showToast(t('housekeeping.checkInDisabled'), 'warning');
    return;
  }
  if (!worker) return;
  if (current) return;
  try {
    const dateValue = new Date().toISOString().slice(0, 10);
    await api.post('/housekeeping/work-sessions/check-in', {
      worker_id: worker.id,
      daily_rate: worker.daily_rate || 0,
      extras: 0,
      ...visitTextPayload(worker, dateValue, worker.daily_rate || 0, 0),
    });
    window.oikos?.showToast(t('housekeeping.checkedInToast'), 'success');
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
        </div>
        <button class="btn btn--secondary housekeeping-check-small" type="button" disabled>
          <i data-lucide="log-in" aria-hidden="true"></i>
          <span>${esc(t('housekeeping.checkIn'))}</span>
        </button>
      </section>
    `;
  }
  const rows = state.workers.map((worker) => {
    const checkedIn = !!(worker.today_session || worker.current_session);
    const session = worker.today_session || worker.current_session;
    return `
    <section class="housekeeping-worker-strip">
      <div class="housekeeping-avatar" style="background:${esc(worker.avatar_color || '#7C3AED')}">
        ${worker.avatar_data ? `<img src="${esc(worker.avatar_data)}" alt="${esc(worker.display_name)}">` : esc(initials(worker.display_name))}
      </div>
      <div>
        <strong>${esc(worker.display_name)}</strong>
        <span>${esc(checkedIn ? `${t('housekeeping.visitRecordedAt')} ${formatTime(session.check_in)}` : `${money(worker.daily_rate)} · ${scheduleLabel(worker.payment_schedule)}`)}</span>
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
  `);
  content.querySelectorAll('[data-worker-check]').forEach((btn) => {
    btn.addEventListener('click', () => toggleSession(document.querySelector('.page-transition') || document.body, btn.dataset.workerCheck));
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
      <span>${esc(template.name)}</span>
      <small>${esc(template.area)} · ${esc(t('housekeeping.everyDays', { days: template.frequency_days }))}</small>
    </button>
  `).join('');
  const taskRows = state.tasks.map((task) => `
    <article class="housekeeping-task housekeeping-task--${esc(task.urgency_status)}">
      <button class="housekeeping-task__check" type="button" data-complete-task="${task.id}"
              aria-label="${esc(t('housekeeping.completeTask', { name: task.name }))}">
        <i data-lucide="check" aria-hidden="true"></i>
      </button>
      <div class="housekeeping-task__body">
        <h2>${esc(task.name)}</h2>
        <p>${esc(task.area)} · ${esc(t('housekeeping.everyDays', { days: task.frequency_days }))}</p>
        <span>${esc(urgencyLabel(task.urgency_status))}</span>
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
        <div class="housekeeping-empty">
          <i data-lucide="list-checks" aria-hidden="true"></i>
          <h2>${esc(t('housekeeping.noTasks'))}</h2>
        </div>
      `}
    </section>
  `);

  content.querySelectorAll('[data-template-index]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const template = state.templates[Number(btn.dataset.templateIndex)];
      if (template) createTask(template, content);
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
}

function renderReports(content) {
  content.replaceChildren();
  const totals = state.visitReport?.totals || {};
  const visits = state.reports || [];
  const rows = visits.map((visit) => {
    const paid = !!visit.paid_at;
    return `
    <article class="housekeeping-report-item housekeeping-report-item--visit">
      <div class="housekeeping-avatar" style="background:${esc(visit.worker_avatar_color || '#7C3AED')}">
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
          <div class="housekeeping-avatar" style="background:${esc(visit.worker_avatar_color || '#7C3AED')}">
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
      <div class="housekeeping-avatar" style="background:${esc(item.avatar_color || '#7C3AED')}">
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
    state.staffLogMonth = event.currentTarget.value || new Date().toISOString().slice(0, 7);
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
          <button class="btn btn--secondary btn--icon" type="button" data-edit-visit="${visit.id}" aria-label="${esc(t('housekeeping.editVisit'))}">
            <i data-lucide="edit-2" aria-hidden="true"></i>
          </button>
          <button class="btn btn--danger-outline btn--icon" type="button" data-delete-visit="${visit.id}" aria-label="${esc(t('housekeeping.deleteVisit'))}">
            <i data-lucide="trash-2" aria-hidden="true"></i>
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

function openVisitEditModal(visit, content) {
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
          <label class="housekeeping-field">
            <span>${esc(t('housekeeping.dailyRate'))}</span>
            <input name="daily_rate" type="number" min="0" step="0.01" inputmode="decimal" value="${esc(visit.daily_rate ?? 0)}">
          </label>
          <label class="housekeeping-field">
            <span>${esc(t('housekeeping.extras'))}</span>
            <input name="extras" type="number" min="0" step="0.01" inputmode="decimal" value="${esc(visit.extras ?? 0)}">
          </label>
        </div>
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
        const dailyRate = Number(fields.daily_rate.value || 0);
        const extras = Number(fields.extras.value || 0);
        try {
          await api.put(`/housekeeping/visits/${visit.id}`, {
            date: dateValue,
            daily_rate: dailyRate,
            extras,
            ...visitTextPayload(worker, dateValue, dailyRate, extras),
          });
          window.oikos?.showToast(t('housekeeping.visitSavedToast'), 'success');
          await loadData();
          state.staffLogMonth = dateValue.slice(0, 7);
          await loadStaffVisits();
          closeModal({ force: true });
          renderStaff(content);
        } catch (err) {
          window.oikos?.showToast(err.message, 'danger');
        }
      });
    },
  });
}

function openStaffModal(worker, content) {
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
                  style="background:${esc(item.avatar_color || '#7C3AED')}" aria-label="${esc(t('housekeeping.profilePicture'))}">
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
            <span>${esc(t('housekeeping.dailyRate'))}</span>
            <input name="daily_rate" type="number" min="0" step="0.01" inputmode="decimal" value="${esc(item.daily_rate ?? 0)}">
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
            payment_schedule: fields.payment_schedule.value,
            calendar_color: fields.calendar_color.value,
            avatar_color: fields.avatar_color.value,
            avatar_data: state.workerAvatar,
            notes: fields.notes.value.trim() || null,
          });
          window.oikos?.showToast(t('housekeeping.workerSavedToast'), 'success');
          await loadData();
          closeModal({ force: true });
          renderStaff(content);
        } catch (err) {
          window.oikos?.showToast(err.message, 'danger');
        }
      });
    },
  });

  const panel = document.querySelector('.modal-panel');
  const avatarFile = panel?.querySelector('#housekeeping-avatar-file');
  const avatarButton = panel?.querySelector('#housekeeping-avatar-btn');
  avatarButton?.addEventListener('click', () => avatarFile?.click());
  avatarFile?.addEventListener('change', () => {
    const file = avatarFile.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.addEventListener('load', () => {
      state.workerAvatar = String(reader.result || '');
      avatarButton.replaceChildren();
      avatarButton.insertAdjacentHTML('beforeend', `<img src="${esc(state.workerAvatar)}" alt="">`);
    });
    reader.readAsDataURL(file);
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
