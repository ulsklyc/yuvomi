/**
 * Modul: Housekeeping
 * Zweck: Mobile-first interface for cleaner work sessions, decay tasks, supplies, and reports
 * Abhängigkeiten: /api.js, /i18n.js, /utils/html.js
 */

import { api } from '/api.js';
import { t, formatDate, formatTime } from '/i18n.js';
import { esc } from '/utils/html.js';

let state = {
  tab: 'home',
  summary: null,
  tasks: [],
  reports: [],
  photoUrl: null,
};

function money(value) {
  return new Intl.NumberFormat(undefined, { style: 'currency', currency: 'BRL' }).format(Number(value || 0));
}

function sessionLabel(session) {
  if (!session) return t('housekeeping.notCheckedIn');
  return `${t('housekeeping.checkedInAt')} ${formatTime(session.check_in)}`;
}

function urgencyLabel(status) {
  if (status === 'overdue') return t('housekeeping.overdue');
  if (status === 'today') return t('housekeeping.dueToday');
  return t('housekeeping.ok');
}

async function loadData() {
  const [summary, tasks, reports] = await Promise.all([
    api.get('/housekeeping/summary'),
    api.get('/housekeeping/decay-tasks'),
    api.get('/housekeeping/maintenance-log'),
  ]);
  state.summary = summary.data;
  state.tasks = tasks.data || [];
  state.reports = reports.data || [];
}

function renderShell(container) {
  container.replaceChildren();
  container.insertAdjacentHTML('beforeend', `
    <section class="housekeeping-page" aria-labelledby="housekeeping-title">
      <header class="housekeeping-toolbar">
        <div class="housekeeping-toolbar__title" id="housekeeping-title">${esc(t('housekeeping.title'))}</div>
        <div class="housekeeping-toolbar__actions">
          <i data-lucide="sparkles" class="housekeeping-toolbar__icon" aria-hidden="true"></i>
        </div>
      </header>
      <nav class="housekeeping-tabs" aria-label="${esc(t('housekeeping.bottomNav'))}">
        ${renderTabButton('home', 'home', t('housekeeping.home'))}
        ${renderTabButton('tasks', 'list-checks', t('housekeeping.tasks'))}
        ${renderTabButton('report', 'camera', t('housekeeping.report'))}
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

function renderTabButton(tab, icon, label) {
  const current = state.tab === tab ? ' aria-current="page"' : '';
  return `
    <button class="housekeeping-tab" type="button" data-housekeeping-tab="${esc(tab)}"${current}>
      <i data-lucide="${esc(icon)}" aria-hidden="true"></i>
      <span>${esc(label)}</span>
    </button>
  `;
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
  else if (state.tab === 'report') renderReport(content);
  else renderHome(content);
  if (window.lucide) window.lucide.createIcons({ el: container });
}

function renderHome(content) {
  content.replaceChildren();
  const summary = state.summary;
  const currentSession = summary?.current_session;
  const defaultRate = summary?.default_daily_rate || 0;
  const total = summary?.summary?.total_amount || 0;
  const sessionCount = summary?.summary?.session_count || 0;

  content.insertAdjacentHTML('beforeend', `
    <section class="housekeeping-card housekeeping-card--focus">
      <div class="housekeeping-status">
        <span>${esc(sessionLabel(currentSession))}</span>
        <strong>${esc(money(total))}</strong>
        <small>${esc(t('housekeeping.monthTotal', { count: sessionCount }))}</small>
      </div>
      <label class="housekeeping-field">
        <span>${esc(t('housekeeping.dailyRate'))}</span>
        <input id="housekeeping-daily-rate" inputmode="decimal" type="number" min="0" step="0.01" value="${esc(defaultRate)}">
      </label>
      <label class="housekeeping-field">
        <span>${esc(t('housekeeping.extras'))}</span>
        <input id="housekeeping-extras" inputmode="decimal" type="number" min="0" step="0.01" value="${esc(currentSession?.extras ?? 0)}">
      </label>
      <button class="housekeeping-check-btn ${currentSession ? 'housekeeping-check-btn--out' : ''}" type="button" id="housekeeping-check-btn">
        <i data-lucide="${currentSession ? 'log-out' : 'log-in'}" aria-hidden="true"></i>
        <span>${esc(currentSession ? t('housekeeping.checkOut') : t('housekeeping.checkIn'))}</span>
      </button>
    </section>

    <section class="housekeeping-card">
      <h2>${esc(t('housekeeping.quickSupply'))}</h2>
      <form id="housekeeping-supply-form" class="housekeeping-inline-form">
        <label class="sr-only" for="housekeeping-supply-name">${esc(t('housekeeping.supplyName'))}</label>
        <input id="housekeeping-supply-name" name="name" required maxlength="200" autocomplete="off"
               placeholder="${esc(t('housekeeping.supplyPlaceholder'))}">
        <button class="btn btn--primary" type="submit">
          <i data-lucide="plus" aria-hidden="true"></i>
          <span>${esc(t('common.add'))}</span>
        </button>
      </form>
    </section>
  `);

  content.querySelector('#housekeeping-check-btn')?.addEventListener('click', async () => {
    const dailyRate = Number(content.querySelector('#housekeeping-daily-rate')?.value || 0);
    const extras = Number(content.querySelector('#housekeeping-extras')?.value || 0);
    try {
      if (currentSession) {
        await api.post('/housekeeping/work-sessions/check-out', { extras });
        window.oikos?.showToast(t('housekeeping.checkedOutToast'), 'success');
      } else {
        await api.post('/housekeeping/work-sessions/check-in', { daily_rate: dailyRate, extras });
        window.oikos?.showToast(t('housekeeping.checkedInToast'), 'success');
      }
      await loadData();
      renderHome(content);
    } catch (err) {
      window.oikos?.showToast(err.message, 'danger');
    }
  });

  content.querySelector('#housekeeping-supply-form')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const input = content.querySelector('#housekeeping-supply-name');
    const name = input?.value.trim();
    if (!name) return;
    try {
      await api.post('/housekeeping/supply-requests', { name });
      input.value = '';
      window.oikos?.showToast(t('housekeeping.supplyAddedToast'), 'success');
    } catch (err) {
      window.oikos?.showToast(err.message, 'danger');
    }
  });
}

function renderTasks(content) {
  content.replaceChildren();
  content.insertAdjacentHTML('beforeend', `
    <section class="housekeeping-card">
      <h2>${esc(t('housekeeping.addTask'))}</h2>
      <form id="housekeeping-task-form" class="housekeeping-task-form">
        <label class="housekeeping-field">
          <span>${esc(t('housekeeping.taskName'))}</span>
          <input name="name" required maxlength="200" autocomplete="off"
                 placeholder="${esc(t('housekeeping.taskNamePlaceholder'))}">
        </label>
        <div class="housekeeping-form-grid">
          <label class="housekeeping-field">
            <span>${esc(t('housekeeping.taskArea'))}</span>
            <input name="area" required maxlength="100" autocomplete="off"
                   placeholder="${esc(t('housekeeping.taskAreaPlaceholder'))}">
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
  `);

  content.querySelector('#housekeeping-task-form')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const name = form.name.value.trim();
    const area = form.area.value.trim();
    const frequencyDays = Number(form.frequency_days.value);
    if (!name || !area || !Number.isInteger(frequencyDays) || frequencyDays < 1) return;
    try {
      await api.post('/housekeeping/decay-tasks', {
        name,
        area,
        frequency_days: frequencyDays,
      });
      form.reset();
      form.frequency_days.value = '7';
      window.oikos?.showToast(t('housekeeping.taskCreatedToast'), 'success');
      await loadData();
      renderTasks(content);
    } catch (err) {
      window.oikos?.showToast(err.message, 'danger');
    }
  });

  if (!state.tasks.length) {
    content.insertAdjacentHTML('beforeend', `
      <section class="housekeeping-card housekeeping-empty">
        <i data-lucide="list-checks" aria-hidden="true"></i>
        <h2>${esc(t('housekeeping.noTasks'))}</h2>
      </section>
    `);
    return;
  }

  const rows = state.tasks.map((task) => `
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

  content.insertAdjacentHTML('beforeend', `<section class="housekeeping-task-list">${rows}</section>`);
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

function renderReport(content) {
  content.replaceChildren();
  const latest = state.reports.slice(0, 3).map((report) => `
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
          <textarea name="description" rows="4" required maxlength="5000"
                    placeholder="${esc(t('housekeeping.problemPlaceholder'))}"></textarea>
        </label>
        <label class="housekeeping-photo">
          <input id="housekeeping-photo-input" type="file" accept="image/png,image/jpeg,image/webp" capture="environment">
          <i data-lucide="camera" aria-hidden="true"></i>
          <span>${esc(t('housekeeping.addPhoto'))}</span>
        </label>
        <img class="housekeeping-photo-preview" id="housekeeping-photo-preview" alt="" hidden>
        <button class="housekeeping-submit-btn" type="submit">
          <i data-lucide="send" aria-hidden="true"></i>
          <span>${esc(t('housekeeping.sendReport'))}</span>
        </button>
      </form>
    </section>
    <section class="housekeeping-reports" aria-label="${esc(t('housekeeping.recentReports'))}">
      ${latest}
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
      await api.post('/housekeeping/maintenance-log', {
        description,
        photo_url: state.photoUrl,
      });
      state.photoUrl = null;
      window.oikos?.showToast(t('housekeeping.reportSentToast'), 'success');
      await loadData();
      renderReport(content);
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
