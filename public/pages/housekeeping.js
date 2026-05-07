/**
 * Modul: Housekeeping
 * Zweck: Dashboard, chore management, reports, and housekeeping staff
 * Abhängigkeiten: /api.js, /i18n.js, /utils/html.js
 */

import { api } from '/api.js';
import { t, formatDate, formatTime } from '/i18n.js';
import { esc } from '/utils/html.js';

let state = {
  tab: 'dashboard',
  dashboard: null,
  tasks: [],
  reports: [],
  templates: [],
  worker: null,
  workers: [],
  photoUrl: null,
  workerAvatar: undefined,
  editingWorker: null,
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

async function loadData() {
  const [dashboard, tasks, reports, templates, workers] = await Promise.all([
    api.get('/housekeeping/dashboard'),
    api.get('/housekeeping/decay-tasks'),
    api.get('/housekeeping/maintenance-log'),
    api.get('/housekeeping/task-templates'),
    api.get('/housekeeping/workers'),
  ]);
  state.dashboard = dashboard.data;
  state.tasks = tasks.data || [];
  state.reports = reports.data || [];
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
        ${renderTabButton('reports', 'message-square-warning', t('housekeeping.reports'))}
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
  const current = worker?.current_session;
  if (!state.workers.length) {
    window.oikos?.showToast(t('housekeeping.checkInDisabled'), 'warning');
    return;
  }
  if (!worker) return;
  try {
    if (current) {
      await api.post('/housekeeping/work-sessions/check-out', { worker_id: worker.id, extras: current.extras || 0 });
      window.oikos?.showToast(t('housekeeping.checkedOutToast'), 'success');
    } else {
      await api.post('/housekeeping/work-sessions/check-in', {
        worker_id: worker.id,
        daily_rate: worker.daily_rate || 0,
        extras: 0,
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
        </div>
        <button class="btn btn--secondary housekeeping-check-small" type="button" disabled>
          <i data-lucide="log-in" aria-hidden="true"></i>
          <span>${esc(t('housekeeping.checkIn'))}</span>
        </button>
      </section>
    `;
  }
  const rows = state.workers.map((worker) => {
    const checkedIn = !!worker.current_session;
    return `
    <section class="housekeeping-worker-strip">
      <div class="housekeeping-avatar" style="background:${esc(worker.avatar_color || '#7C3AED')}">
        ${worker.avatar_data ? `<img src="${esc(worker.avatar_data)}" alt="${esc(worker.display_name)}">` : esc(initials(worker.display_name))}
      </div>
      <div>
        <strong>${esc(worker.display_name)}</strong>
        <span>${esc(checkedIn ? `${t('housekeeping.checkedInAt')} ${formatTime(worker.current_session.check_in)}` : `${money(worker.daily_rate)} · ${scheduleLabel(worker.payment_schedule)}`)}</span>
      </div>
      <button class="btn ${checkedIn ? 'btn--danger-outline' : 'btn--primary'} housekeeping-check-small" type="button"
              data-worker-check="${worker.id}">
        <i data-lucide="${checkedIn ? 'log-out' : 'log-in'}" aria-hidden="true"></i>
        <span>${esc(checkedIn ? t('housekeeping.checkOut') : t('housekeeping.checkIn'))}</span>
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
  const latest = state.reports.map((report) => `
    <article class="housekeeping-report-item">
      ${report.photo_url ? `<img src="${esc(report.photo_url)}" alt="">` : '<i data-lucide="wrench" aria-hidden="true"></i>'}
      <div>
        <strong>${esc(report.description)}</strong>
        <span>${esc(formatDate(report.created_at))}</span>
      </div>
    </article>
  `).join('');

  content.insertAdjacentHTML('beforeend', `
    <section class="housekeeping-card">
      <h2>${esc(t('housekeeping.reportTitle'))}</h2>
      <form id="housekeeping-report-form" class="housekeeping-report-form">
        <label class="housekeeping-field">
          <span>${esc(t('housekeeping.problemDescription'))}</span>
          <textarea name="description" rows="4" required maxlength="5000" placeholder="${esc(t('housekeeping.problemPlaceholder'))}"></textarea>
        </label>
        <label class="housekeeping-photo">
          <input id="housekeeping-photo-input" type="file" accept="image/png,image/jpeg,image/webp" capture="environment">
          <i data-lucide="camera" aria-hidden="true"></i>
          <span>${esc(t('housekeeping.addPhoto'))}</span>
        </label>
        <img class="housekeeping-photo-preview" id="housekeeping-photo-preview" alt="" hidden>
        <button class="btn btn--primary housekeeping-form-submit" type="submit">
          <i data-lucide="send" aria-hidden="true"></i>
          <span>${esc(t('housekeeping.sendReport'))}</span>
        </button>
      </form>
    </section>
    <section class="housekeeping-reports" aria-label="${esc(t('housekeeping.recentReports'))}">
      ${latest || `<p class="housekeeping-muted">${esc(t('housekeeping.noReports'))}</p>`}
    </section>
  `);

  const photoInput = content.querySelector('#housekeeping-photo-input');
  const preview = content.querySelector('#housekeeping-photo-preview');
  photoInput?.addEventListener('change', () => {
    const file = photoInput.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.addEventListener('load', () => {
      state.photoUrl = String(reader.result || '');
      if (preview) {
        preview.src = state.photoUrl;
        preview.hidden = false;
      }
    });
    reader.readAsDataURL(file);
  });

  content.querySelector('#housekeeping-report-form')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const description = form.description.value.trim();
    if (!description) return;
    try {
      await api.post('/housekeeping/maintenance-log', { description, photo_url: state.photoUrl });
      state.photoUrl = null;
      window.oikos?.showToast(t('housekeeping.reportSentToast'), 'success');
      await loadData();
      renderReports(content);
    } catch (err) {
      window.oikos?.showToast(err.message, 'danger');
    }
  });
}

function renderStaff(content) {
  content.replaceChildren();
  const worker = state.editingWorker || {};
  state.workerAvatar = worker.avatar_data ?? null;
  const workerRows = state.workers.map((item) => `
    <article class="housekeeping-staff-row">
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
    <section class="housekeeping-card">
      <h2>${esc(worker.id ? t('housekeeping.editWorker') : t('housekeeping.addWorker'))}</h2>
      <form id="housekeeping-worker-form" class="housekeeping-worker-form">
        <input type="hidden" name="id" value="${esc(worker.id || '')}">
        <div class="housekeeping-profile-editor">
          <button class="housekeeping-avatar housekeeping-avatar--lg" type="button" id="housekeeping-avatar-btn"
                  style="background:${esc(worker.avatar_color || '#7C3AED')}" aria-label="${esc(t('housekeeping.profilePicture'))}">
            ${worker.avatar_data ? `<img src="${esc(worker.avatar_data)}" alt="${esc(worker.display_name || '')}">` : esc(initials(worker.display_name || 'HK'))}
          </button>
          <input class="sr-only" type="file" id="housekeeping-avatar-file" accept="image/png,image/jpeg,image/webp">
          <div class="housekeeping-profile-editor__fields">
            <label class="housekeeping-field">
              <span>${esc(t('housekeeping.workerName'))}</span>
              <input name="display_name" required maxlength="128" value="${esc(worker.display_name || '')}">
            </label>
            <label class="housekeeping-field">
              <span>${esc(t('housekeeping.workerUsername'))}</span>
              <input name="username" maxlength="64" autocomplete="off" value="${esc(worker.username || '')}">
            </label>
          </div>
        </div>
        <div class="housekeeping-form-grid housekeeping-form-grid--wide">
          <label class="housekeeping-field">
            <span>${esc(t('housekeeping.workerPhone'))}</span>
            <input name="phone" type="tel" autocomplete="tel" value="${esc(worker.phone || '')}">
          </label>
          <label class="housekeeping-field">
            <span>${esc(t('housekeeping.workerEmail'))}</span>
            <input name="email" type="email" autocomplete="email" value="${esc(worker.email || '')}">
          </label>
          <label class="housekeeping-field">
            <span>${esc(t('housekeeping.workerBirthDate'))}</span>
            <input name="birth_date" type="date" value="${esc(worker.birth_date || '')}">
          </label>
          <label class="housekeeping-field">
            <span>${esc(t('housekeeping.dailyRate'))}</span>
            <input name="daily_rate" type="number" min="0" step="0.01" inputmode="decimal" value="${esc(worker.daily_rate ?? 0)}">
          </label>
          <label class="housekeeping-field housekeeping-field--color">
            <span>${esc(t('housekeeping.calendarColor'))}</span>
            <input name="calendar_color" type="color" value="${esc(worker.calendar_color || '#7C3AED')}">
          </label>
          <label class="housekeeping-field">
            <span>${esc(t('housekeeping.paymentSchedule'))}</span>
            <select name="payment_schedule">
              <option value="daily"${worker.payment_schedule === 'daily' ? ' selected' : ''}>${esc(t('housekeeping.scheduleDaily'))}</option>
              <option value="twice_monthly"${worker.payment_schedule === 'twice_monthly' ? ' selected' : ''}>${esc(t('housekeeping.scheduleTwiceMonthly'))}</option>
              <option value="monthly"${!worker.payment_schedule || worker.payment_schedule === 'monthly' ? ' selected' : ''}>${esc(t('housekeeping.scheduleMonthly'))}</option>
            </select>
          </label>
          <label class="housekeeping-field housekeeping-field--color">
            <span>${esc(t('housekeeping.profileColor'))}</span>
            <input name="avatar_color" type="color" value="${esc(worker.avatar_color || '#7C3AED')}">
          </label>
        </div>
        <label class="housekeeping-field">
          <span>${esc(t('housekeeping.workerNotes'))}</span>
          <textarea name="notes" rows="3" maxlength="5000">${esc(worker.notes || '')}</textarea>
        </label>
        <button class="btn btn--primary housekeeping-form-submit" type="submit">
          <i data-lucide="save" aria-hidden="true"></i>
          <span>${esc(t('common.save'))}</span>
        </button>
      </form>
    </section>
  `);

  content.querySelector('#housekeeping-new-worker')?.addEventListener('click', () => {
    state.editingWorker = null;
    renderStaff(content);
  });
  content.querySelectorAll('[data-edit-worker]').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.editingWorker = state.workers.find((item) => String(item.id) === btn.dataset.editWorker) || null;
      renderStaff(content);
    });
  });

  const avatarFile = content.querySelector('#housekeeping-avatar-file');
  const avatarButton = content.querySelector('#housekeeping-avatar-btn');
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
  content.querySelector('#housekeeping-worker-form')?.addEventListener('submit', async (event) => {
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
      state.editingWorker = null;
      renderStaff(content);
    } catch (err) {
      window.oikos?.showToast(err.message, 'danger');
    }
  });
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
