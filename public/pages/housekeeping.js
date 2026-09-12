/**
 * Modul: Housekeeping
 * Zweck: Dashboard, chore management, reports, and housekeeping staff
 * Abhängigkeiten: /api.js, /i18n.js, /utils/html.js
 */

import { api } from '/api.js';
import { t, formatDate, formatTime, getLocale, getNumberFormat } from '/i18n.js';
import { esc } from '/utils/html.js';
import { renderSkeletonList } from '/utils/skeleton.js';
import { emptyStateHTML, mountLoadError } from '/utils/empty-state.js';
import { openModal, closeModal, confirmModal, confirmOverModal, refocusAfterRender } from '/components/modal.js';
import { createPageFab, setPageFabAction } from '/utils/fab.js';
import { wireTablist } from '/utils/tablist.js';
import { wireScrollFade } from '/utils/ux.js';
import { amountPlaceholder, amountStep, amountIsSavable, smallestUnitLabel } from '/utils/money.js';
import { maxUploadBytes, maxUploadMb } from '/utils/upload-limit.js';



function localDate(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// "2026-07" ist ein API-Schlüssel, kein Anzeigetext: Leser bekommen den
// lokalisierten Monatsnamen (Audit A2-23).
function formatMonthLabel(ym, opts = { month: 'long', year: 'numeric' }) {
  if (!/^\d{4}-\d{2}$/.test(String(ym || ''))) return String(ym || '');
  return new Intl.DateTimeFormat(getLocale(), opts).format(new Date(`${ym}-01T00:00:00`));
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
  return getNumberFormat({ style: 'currency', currency: state.currency }).format(Number(value || 0));
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
  const on = state.tab === tab;
  return `
    <button class="housekeeping-tab sub-tab${on ? ' sub-tab--active' : ''}" type="button" role="tab"
            data-tab-id="${esc(tab)}" aria-controls="housekeeping-content"
            aria-selected="${on ? 'true' : 'false'}"${on ? ' aria-current="page"' : ''} tabindex="${on ? '0' : '-1'}">
      <i class="sub-tab__icon" data-lucide="${esc(icon)}" aria-hidden="true"></i>
      <span class="sub-tab__label">${esc(label)}</span>
    </button>
  `;
}

// Kontext-FAB: folgt dem aktiven Tab. Nur „Personal" hat eine Modal-Erstellung;
// „Aufgaben" nutzt ein dauerhaftes Inline-Formular, „Übersicht"/„Berichte" haben
// keine Erstellen-Aktion → FAB dort ausgeblendet.
let fab = null;

function updateHousekeepingFab() {
  if (!fab) return;
  if (state.tab === 'staff') {
    setPageFabAction(fab, {
      label: t('housekeeping.addWorker'),
      onClick: () => openStaffModal(null, document.querySelector('#housekeeping-content')),
    });
  } else {
    setPageFabAction(fab, { hidden: true });
  }
}

function renderShell(container) {
  container.replaceChildren();
  container.insertAdjacentHTML('beforeend', `
    <section class="housekeeping-page app-page app-page--data" data-composition="data" aria-labelledby="housekeeping-title">
      <header class="page-toolbar page-toolbar--narrow housekeeping-toolbar">
        <h1 class="page-toolbar__title" id="housekeeping-title">${esc(t('housekeeping.title'))}</h1>
        <nav class="housekeeping-tabs page-toolbar__bar" role="tablist" aria-label="${esc(t('housekeeping.bottomNav'))}">
          ${renderTabButton('dashboard', 'layout-dashboard', t('housekeeping.dashboard'))}
          ${renderTabButton('tasks', 'list-checks', t('housekeeping.tasks'))}
          ${renderTabButton('reports', 'file-text', t('housekeeping.reports'))}
          ${renderTabButton('staff', 'users-round', t('housekeeping.staff'))}
        </nav>
      </header>
      <div class="housekeeping-content" id="housekeeping-content"></div>
    </section>
  `);

  fab = createPageFab({ id: 'housekeeping-fab' });
  container.querySelector('.housekeeping-page').appendChild(fab);

  wireTablist(container.querySelector('.housekeeping-tabs'), {
    activeId: state.tab,
    onChange: (id) => { state.tab = id; renderCurrentTab(container); },
  });
  // Scroll-Affordanz der Bar-Zeile: laeuft die Leiste ueber (schmale Geraete,
  // lange Locales), zeigt der geteilte Peek-Fade (.page-toolbar__bar) den
  // Anschnitt statt Tabs stumm zu verstecken.
  wireScrollFade(container.querySelector('.housekeeping-tabs'));
  renderCurrentTab(container);
}

function renderCurrentTab(container) {
  const content = container.querySelector('#housekeeping-content');
  if (!content) return;
  content.replaceChildren();
  if (state.tab === 'tasks') renderTasks(content);
  else if (state.tab === 'reports') renderReports(content);
  else if (state.tab === 'staff') renderStaff(content);
  else renderDashboard(content);
  updateHousekeepingFab();
  if (window.lucide) window.lucide.createIcons({ el: container });
}

async function toggleSession(container, workerId) {
  const worker = state.workers.find((item) => String(item.id) === String(workerId));
  // `current_session` ist die noch offene Sitzung. `today_session` traegt auch
  // eine abgeschlossene und haette hier ein zweites Auschecken ausgeloest.
  const current = worker?.current_session;
  if (!state.workers.length) {
    window.yuvomi?.showToast(t('housekeeping.checkInDisabled'), 'warning');
    return;
  }
  if (!worker) return;
  try {
    if (current) {
      await api.post('/housekeeping/work-sessions/check-out', { worker_id: worker.id });
      window.yuvomi?.showToast(t('housekeeping.checkedOutToast'), 'success');
    } else {
      await api.post('/housekeeping/work-sessions/check-in', {
        worker_id: worker.id,
        daily_rate: worker.rate_type === 'hourly' ? 0 : (worker.daily_rate || 0),
        extras: 0,
        local_date: localDate(),
        timezone_offset_minutes: new Date().getTimezoneOffset(),
        ...visitTextPayload(worker, localDate(), worker.rate_type === 'hourly' ? 0 : (worker.daily_rate || 0), 0),
      });
      window.yuvomi?.showToast(t('housekeeping.checkedInToast'), 'success');
    }
    await loadData();
    renderShell(container);
  } catch (err) {
    window.yuvomi?.showToast(err.message, 'danger');
  }
}

function renderWorkerSummary() {
  if (!state.workers.length) {
    return emptyStateHTML({
      icon: 'user-plus',
      title: t('housekeeping.noWorkerTitle'),
      description: t('housekeeping.noWorkerHint'),
      action: {
        label: t('housekeeping.setupProfileAction'),
        icon: 'plus',
        attrs: { id: 'housekeeping-create-profile' },
      },
    });
  }
  const rows = state.workers.map((worker) => {
    // Derselbe Knopf fuehrt beide Richtungen: toggleSession() liest die offene
    // Sitzung und checkt aus, sonst ein. Er trug im eingecheckten Zustand ein
    // disabled-Attribut - und weil er der EINZIGE Ausloeser ist, war der
    // Auscheck-Zweig damit unerreichbar (#1133).
    const checkedIn = !!worker.current_session;
    // Zwei verschiedene Fragen: `checkedIn` traegt den Knopf ("arbeitet
    // gerade"), `session` die Zeile darunter ("war heute da"). Haengt die
    // Zeile am Knopf, verliert sie nach dem Auschecken den Besuch von heute
    // und faellt auf den Tarif zurueck.
    const session = worker.current_session ?? worker.today_session;
    return `
    <section class="housekeeping-worker-strip">
      <div class="housekeeping-avatar" style="background:${esc(worker.avatar_color) || 'var(--module-housekeeping)'}">
        ${worker.avatar_data ? `<img src="${esc(worker.avatar_data)}" alt="${esc(worker.display_name)}">` : esc(initials(worker.display_name))}
      </div>
      <div class="housekeeping-worker-strip__identity">
        <strong>${esc(worker.display_name)}</strong>
        <span>${esc(session ? `${t('housekeeping.visitRecordedAt')} ${formatTime(session.check_in)}` : (worker.rate_type === 'hourly' ? `${money(worker.hourly_rate)}/${t('housekeeping.rateHourly')}` : `${money(worker.daily_rate)} · ${scheduleLabel(worker.payment_schedule)}`))}</span>
      </div>
      <button class="btn ${checkedIn ? 'btn--secondary' : 'btn--primary'} housekeeping-check-small" type="button"
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
  if (!state.workers.length) {
    content.insertAdjacentHTML('beforeend', renderWorkerSummary());
    content.querySelector('#housekeeping-create-profile')?.addEventListener('click', () => {
      openStaffModal(null, content, { afterSave: () => renderDashboard(content) });
    });
    return;
  }
  // DATUM ALS WERT, UHRZEIT ALS FUSSNOTE.
  // Beides zusammen in der Kennzahl ergab „18.08.2026 · 08:30" und lief in
  // Title 1 gemessen 38px ueber die Kartenkante - eine Kennzahl traegt EINE
  // Aussage, die Praezisierung darunter gehoert in `.metric-card__note`
  // (dieselbe Rolle wie „7 aktiv" bei den Abos).
  const hasLastVisit = Boolean(data.last_visit?.check_in);
  const lastVisit = hasLastVisit ? formatDate(data.last_visit.check_in) : t('housekeeping.noVisits');
  const lastVisitTime = hasLastVisit ? formatTime(data.last_visit.check_in) : '';
  const maxPayment = Math.max(1, ...(data.monthly_payments || []).map((row) => row.total));
  const bars = (data.monthly_payments || []).map((row) => {
    // ANTEIL, KEINE PIXELHOEHE. Hier stand `style="height:${...}px"` mit einer
    // im JS gerechneten Zahl - ein hartkodierter Designwert im Markup, und der
    // Balken skalierte deshalb nicht mit seiner Karte. Der Wert ist DATEN
    // (0..1), die Geometrie gehoert dem Stylesheet; dieselbe Bauart wie
    // `--span-from/--span-to` am Wetterbalken und `--bar-scale` im Budget.
    // Der Mindestanteil haelt einen Monat ohne Zahlung sichtbar.
    const scale = Math.max(0.06, row.total / maxPayment);
    // Wert sichtbar am Balken statt nur im Hover-title: das Chart trug sonst
    // keine ablesbare Achse oder Zahl (Audit A2-23).
    return `
      <div class="housekeeping-chart__bar-wrap">
        <span class="housekeeping-chart__value">${esc(money(row.total))}</span>
        <div class="housekeeping-chart__track" title="${esc(formatMonthLabel(row.month))} ${esc(money(row.total))}">
          <div class="housekeeping-chart__bar" style="--bar-scale:${scale.toFixed(4)}"></div>
        </div>
        <span>${esc(formatMonthLabel(row.month, { month: 'short' }))}</span>
      </div>
    `;
  }).join('');

  const recentVisits = (state.reports || []).slice(0, 5);
  const recentRows = recentVisits.map((visit) => `
    <article class="list-row housekeeping-staff-log-row">
      <div class="list-row__main">
        <div class="list-row__name">${esc(formatDate(visit.check_in))}</div>
        <div class="list-row__meta">${esc(visit.worker_name || t('housekeeping.staff'))} · ${esc(money(visit.total_amount))} · ${esc(visit.paid_at ? t('housekeeping.paymentPaid') : t('housekeeping.paymentPending'))}</div>
      </div>
      <div class="list-row__actions">
        <button class="row-action" type="button" data-edit-visit="${esc(visit.id)}"
                aria-label="${esc(t('housekeeping.editVisit'))}: ${esc(formatDate(visit.check_in))}">
          <i data-lucide="edit-2" class="icon-md" aria-hidden="true"></i>
        </button>
      </div>
    </article>
  `).join('');

  content.insertAdjacentHTML('beforeend', `
    ${renderWorkerSummary()}
    <section class="metric-grid metric-grid--quad">
      <article class="metric-card">
        <div class="metric-card__label">${esc(t('housekeeping.visitsThisMonth'))}</div>
        <div class="metric-card__value">${esc(data.visits_this_month ?? 0)}</div>
      </article>
      <article class="metric-card">
        <div class="metric-card__label">${esc(t('housekeeping.lastVisit'))}</div>
        <div class="metric-card__value">${esc(lastVisit)}</div>
        ${lastVisitTime ? `<div class="metric-card__note">${esc(lastVisitTime)}</div>` : ''}
      </article>
      <article class="metric-card">
        <div class="metric-card__label">${esc(t('housekeeping.pendingChores'))}</div>
        <div class="metric-card__value">${esc(data.pending_tasks ?? 0)}</div>
      </article>
      <article class="metric-card">
        <div class="metric-card__label">${esc(t('housekeeping.finishedChores'))}</div>
        <div class="metric-card__value">${esc(data.finished_tasks_this_month ?? 0)}</div>
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
    window.yuvomi?.showToast(t('housekeeping.taskCreatedToast'), 'success');
    await loadData();
    renderTasks(content);
  } catch (err) {
    window.yuvomi?.showToast(err.message, 'danger');
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
      <div class="housekeeping-task__actions row-actions">
        ${task.last_completed ? `
          <button class="row-action" type="button" data-undo-task="${esc(task.id)}"
                  aria-label="${esc(t('housekeeping.undoTask'))}">
            <i data-lucide="rotate-ccw" aria-hidden="true"></i>
          </button>` : ''}
        <button class="row-action" type="button" data-edit-task="${esc(task.id)}"
                aria-label="${esc(t('housekeeping.editTask'))}">
          <i data-lucide="edit-2" aria-hidden="true"></i>
        </button>
        <button class="row-action row-action--danger" type="button" data-delete-task="${esc(task.id)}"
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
    <section class="housekeeping-task-list row-carrier">
      ${taskRows || emptyStateHTML({ icon: 'list-checks', title: t('housekeeping.noTasks') })}
    </section>
  `);
  if (window.lucide) window.lucide.createIcons({ el: content });

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
        window.yuvomi?.showToast(t('housekeeping.taskDoneToast'), 'success');
        await loadData();
        renderTasks(content);
      } catch (err) {
        window.yuvomi?.showToast(err.message, 'danger');
      }
    });
  });

  content.querySelectorAll('[data-undo-task]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      try {
        await api.patch(`/housekeeping/decay-tasks/${btn.dataset.undoTask}`, { last_completed: null });
        window.yuvomi?.showToast(t('housekeeping.taskUndoneToast'), 'success');
        await loadData();
        renderTasks(content);
      } catch (err) {
        window.yuvomi?.showToast(err.message, 'danger');
      }
    });
  });

  content.querySelectorAll('[data-delete-task]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const task = state.tasks.find((it) => String(it.id) === btn.dataset.deleteTask);
      if (!task) return;
      if (!await confirmModal(
        t('housekeeping.deleteTaskConfirm', { name: task.name }),
        { danger: true, confirmLabel: t('common.delete'), detail: t('housekeeping.deleteTaskConfirmDetail') },
      )) return;
      try {
        await api.delete(`/housekeeping/decay-tasks/${task.id}`);
        window.yuvomi?.showToast(t('housekeeping.taskDeletedToast'), 'success');
        await loadData();
        renderTasks(content);
        refocusAfterRender();
      } catch (err) {
        window.yuvomi?.showToast(err.message, 'danger');
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

/* BEZAHLEN WIRD BESTAETIGT (#1136). Die Buchung hat Folgen, die ein Klick nicht
 * zeigt: sie hakt die verknuepfte Zahlungsaufgabe ab, und ab da ist der Besuch
 * abgerechnet - aendern, loeschen oder zuruecknehmen kann ihn nur noch ein
 * Admin. Alle drei Ausloeser (Berichtsliste, Besuchsbericht, Personal-Protokoll)
 * laufen deshalb durch diese eine Funktion; test-frontend-audit.js haelt, dass
 * es keinen Weg daran vorbei gibt.
 *
 * `confirmOverModal` statt `confirmModal`: aus dem Besuchsbericht heraus
 * gefragt, verdraengte `confirmModal` den Bericht, und Abbrechen liesse ihn
 * verschwunden zurueck. `closeOnConfirm: false` holt ihn auch nach dem Ja
 * zurueck - scheitert die Buchung, steht der Bericht noch da; geschlossen wird
 * erst in `onPaid`. Ohne offenes Modal verhaelt es sich wie `confirmModal`. */
async function payVisit(visit, onPaid) {
  const confirmed = await confirmOverModal(t('housekeeping.markPaidConfirm'), {
    closeOnConfirm: false,
    confirmLabel: t('housekeeping.markPaid'),
    detail: visit.payment_task_id
      ? t('housekeeping.markPaidConfirmDetailTask')
      : t('housekeeping.markPaidConfirmDetail'),
  });
  if (!confirmed) return;
  try {
    await api.post(`/housekeeping/visits/${visit.id}/pay`, {});
    window.yuvomi?.showToast(t('housekeeping.visitPaidToast'), 'success');
    await onPaid();
    refocusAfterRender();
  } catch (err) {
    window.yuvomi?.showToast(err.message, 'danger');
  }
}

/* Der Rueckweg (#1136). Ob er angeboten wird, entscheidet der Server je Besuch
 * (`can_mark_unpaid`); die Route prueft die Rolle beim Schreiben selbst. Dieselbe
 * Form wie `payVisit`, damit der Bericht auch hier einen Fehler ueberlebt. */
async function unpayVisit(visit, onUnpaid) {
  const confirmed = await confirmOverModal(t('housekeeping.markUnpaidConfirm'), {
    closeOnConfirm: false,
    confirmLabel: t('housekeeping.markUnpaid'),
    detail: t('housekeeping.markUnpaidConfirmDetail'),
  });
  if (!confirmed) return;
  try {
    await api.post(`/housekeeping/visits/${visit.id}/unpay`, {});
    window.yuvomi?.showToast(t('housekeeping.visitUnpaidToast'), 'success');
    await onUnpaid();
    refocusAfterRender();
  } catch (err) {
    window.yuvomi?.showToast(err.message, 'danger');
  }
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
      ${paid ? '' : `
      <button class="btn btn--secondary" type="button" data-pay-report="${visit.id}">
        <i data-lucide="check" class="icon-sm" aria-hidden="true"></i>${esc(t('housekeeping.markPaid'))}
      </button>`}
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
        <span>${esc(formatMonthLabel(state.visitReport?.month || ''))}</span>
      </div>
      <section class="metric-grid">
        <article class="metric-card metric-card--inset">
          <div class="metric-card__label">${esc(t('housekeeping.visitsThisMonth'))}</div>
          <div class="metric-card__value">${esc(visits.length)}</div>
        </article>
        <article class="metric-card metric-card--inset">
          <div class="metric-card__label">${esc(t('housekeeping.pendingPayments'))}</div>
          <div class="metric-card__value">${esc(money(totals.pending || 0))}</div>
        </article>
        <article class="metric-card metric-card--inset">
          <div class="metric-card__label">${esc(t('housekeeping.paymentPaid'))}</div>
          <div class="metric-card__value">${esc(money(totals.paid || 0))}</div>
        </article>
      </section>
    </section>
    <section class="housekeeping-reports" aria-label="${esc(t('housekeeping.recentReports'))}">
      ${rows || `<p class="housekeeping-muted">${esc(t('housekeeping.noVisitReports'))}</p>`}
    </section>
  `);
  if (window.lucide) window.lucide.createIcons({ el: content });

  content.querySelectorAll('[data-visit-report]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const visit = visits.find((item) => String(item.id) === btn.dataset.visitReport);
      if (visit) openVisitReportModal(visit, content);
    });
  });

  // Bezahlen direkt an der Ausstehend-Zeile (Audit R2, A2-14): derselbe Flow
  // wie im Personal-Einsatzlog, hier gegen die Berichtsliste.
  content.querySelectorAll('[data-pay-report]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const visit = visits.find((item) => String(item.id) === btn.dataset.payReport);
      if (!visit) return;
      payVisit(visit, async () => {
        await loadData();
        renderReports(content);
      });
    });
  });
}

function openVisitReportModal(visit, content = null) {
  const paid = !!visit.paid_at;
  // Die Ruecknahme bietet nur an, wem der Server sie zugesteht
  // (`can_mark_unpaid`, #1136) - die Admin-Regel wird hier nicht nachgebaut.
  let footerAction = '';
  if (!paid) {
    footerAction = `
          <button class="btn btn--primary" type="button" id="visit-report-pay">
            <i data-lucide="check" class="icon-sm" aria-hidden="true"></i>${esc(t('housekeeping.markPaid'))}
          </button>`;
  } else if (visit.can_mark_unpaid) {
    footerAction = `
          <button class="btn btn--secondary" type="button" id="visit-report-unpay">
            <i data-lucide="rotate-ccw" class="icon-sm" aria-hidden="true"></i>${esc(t('housekeeping.markUnpaid'))}
          </button>`;
  }
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
          ${visit.payment_task_id ? `<div><dt>${esc(t('housekeeping.paymentTask'))}</dt><dd>#${esc(visit.payment_task_id)}</dd></div>` : ''}
          ${visit.calendar_event_id ? `<div><dt>${esc(t('housekeeping.calendarEvent'))}</dt><dd>#${esc(visit.calendar_event_id)}</dd></div>` : ''}
        </dl>
        ${footerAction ? `
        <div class="modal-panel__footer modal-panel__footer--plain">
          <button class="btn btn--ghost" type="button" data-action="close-modal">${esc(t('common.cancel'))}</button>
          ${footerAction}
        </div>` : ''}
      </div>
    `,
    onSave(panel) {
      panel.querySelector('#visit-report-pay')?.addEventListener('click', () => payVisit(visit, async () => {
        closeModal({ force: true });
        await loadData();
        if (content?.isConnected) renderReports(content);
        refocusAfterRender();
      }));
      panel.querySelector('#visit-report-unpay')?.addEventListener('click', () => unpayVisit(visit, async () => {
        closeModal({ force: true });
        await loadData();
        if (content?.isConnected) renderReports(content);
        refocusAfterRender();
      }));
    },
  });
}

function renderStaff(content) {
  content.replaceChildren();
  const workerRows = state.workers.map((item) => `
    <!-- Auswahl haengt am Namens-BUTTON, nicht am article: role=button auf dem
         Container ist fuer <article> keine erlaubte Rolle und machte den
         Edit-Button zum verschachtelten Interaktiven (axe). Der article bleibt
         Maus-Klickflaeche ueber data-select-worker + Delegation. -->
    <article class="housekeeping-staff-row ${String(state.selectedStaffId || '') === String(item.id) ? 'housekeeping-staff-row--active' : ''}"
             data-select-worker="${item.id}">
      <div class="housekeeping-avatar" style="background:${esc(item.avatar_color) || 'var(--module-housekeeping)'}">
        ${item.avatar_data ? `<img src="${esc(item.avatar_data)}" alt="${esc(item.display_name)}">` : esc(initials(item.display_name))}
      </div>
      <button class="housekeeping-staff-row__select" type="button">
        <strong>${esc(item.display_name)}</strong>
        <span>${esc(item.phone || item.email || '')}</span>
      </button>
      <button class="btn btn--secondary btn--icon" type="button" data-edit-worker="${item.id}" aria-label="${esc(t('common.edit'))}">
        <i data-lucide="edit-2" aria-hidden="true"></i>
      </button>
    </article>
  `).join('');
  content.insertAdjacentHTML('beforeend', `
    <section class="housekeeping-card">
      <div class="housekeeping-section-heading">
        <h2>${esc(t('housekeeping.staffTitle'))}</h2>
      </div>
      <div class="housekeeping-staff-list">
        ${workerRows || `<p class="housekeeping-muted">${esc(t('housekeeping.noWorkers'))}</p>`}
      </div>
    </section>
    ${state.selectedStaffId ? renderStaffVisitLog() : ''}
  `);

  content.querySelectorAll('[data-select-worker]').forEach((row) => {
    const select = async () => {
      state.selectedStaffId = row.dataset.selectWorker;
      try {
        await loadStaffVisits();
        renderStaff(content);
      } catch (err) {
        window.yuvomi?.showToast(err.message, 'danger');
      }
    };
    // Enter/Space auf dem Namens-Button feuert dessen nativen click und
    // bubbelt hierher - ein eigener keydown-Handler entfiele als Doppelung.
    row.addEventListener('click', (event) => {
      if (event.target.closest('[data-edit-worker]')) return;
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
      window.yuvomi?.showToast(err.message, 'danger');
    }
  });
  content.querySelectorAll('[data-edit-visit]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const visit = state.staffVisits.find((item) => String(item.id) === btn.dataset.editVisit);
      if (visit) openVisitEditModal(visit, content);
    });
  });
  content.querySelectorAll('[data-pay-visit]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const visit = state.staffVisits.find((item) => String(item.id) === btn.dataset.payVisit);
      if (!visit) return;
      payVisit(visit, async () => {
        await loadData();
        await loadStaffVisits();
        renderStaff(content);
      });
    });
  });
  content.querySelectorAll('[data-delete-visit]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const visit = state.staffVisits.find((item) => String(item.id) === btn.dataset.deleteVisit);
      if (!visit) return;
      if (!await confirmModal(t('housekeeping.deleteVisitConfirm'),
        { danger: true, confirmLabel: t('common.delete'), detail: t('housekeeping.deleteVisitConfirmDetail') })) return;
      try {
        await api.delete(`/housekeeping/visits/${visit.id}`);
        window.yuvomi?.showToast(t('housekeeping.visitDeletedToast'), 'success');
        await loadData();
        await loadStaffVisits();
        renderStaff(content);
        refocusAfterRender();
      } catch (err) {
        window.yuvomi?.showToast(err.message, 'danger');
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
    /* Die Zeile des Personal-Protokolls ist DIESELBE wie die der Übersicht -
     * die drei Aktionen sind der einzige Unterschied, und sie stehen in der
     * geteilten Bedienzone. Der Zahlstatus geht dabei nicht verloren: er steht
     * in der Metazeile, wo er die Zeile beschreibt, statt nur als Beschriftung
     * eines Knopfs, der ausgegraut ist. */
    const visitDate = formatDate(visit.check_in);
    return `
      <article class="list-row housekeeping-staff-log-row">
        <div class="list-row__main">
          <div class="list-row__name">${esc(visitDate)}</div>
          <div class="list-row__meta">${esc(money(visit.total_amount))} · ${esc(paid ? t('housekeeping.paymentPaid') : t('housekeeping.paymentPending'))}</div>
        </div>
        <div class="list-row__actions">
          <button class="row-action" type="button" data-pay-visit="${visit.id}" ${paid ? 'disabled' : ''}
                  aria-label="${esc(paid ? t('housekeeping.paymentPaid') : t('housekeeping.markPaid'))}: ${esc(visitDate)}">
            <i data-lucide="badge-dollar-sign" class="icon-md" aria-hidden="true"></i>
          </button>
          <button class="row-action" type="button" data-edit-visit="${visit.id}"
                  aria-label="${esc(t('housekeeping.editVisit'))}: ${esc(visitDate)}">
            <i data-lucide="edit-2" class="icon-md" aria-hidden="true"></i>
          </button>
          <button class="row-action row-action--danger" type="button" data-delete-visit="${visit.id}"
                  aria-label="${esc(t('housekeeping.deleteVisit'))}: ${esc(visitDate)}">
            <i data-lucide="trash-2" class="icon-md" aria-hidden="true"></i>
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
          window.yuvomi?.showToast(t('housekeeping.taskUpdatedToast'), 'success');
          await loadData();
          closeModal({ force: true });
          renderTasks(content);
        } catch (err) {
          window.yuvomi?.showToast(err.message, 'danger');
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
          <yuvomi-datepicker name="date" type="date" value="${esc(visit.check_in.slice(0, 10))}"></yuvomi-datepicker>
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
              <input name="daily_rate" type="number" min="0" step="${amountStep(state.currency, visit.daily_rate ?? 0)}"
                     placeholder="${amountPlaceholder(state.currency)}" inputmode="decimal" value="${esc(visit.daily_rate ?? 0)}">
            </label>
          `}
          <label class="housekeeping-field">
            <span>${esc(t('housekeeping.extras'))}</span>
            <input name="extras" type="number" min="0" step="${amountStep(state.currency, visit.extras ?? 0)}"
                   placeholder="${amountPlaceholder(state.currency)}" inputmode="decimal" value="${esc(visit.extras ?? 0)}">
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
        // Wie beim Mitarbeitersatz: liegt der Bestandswert neben dem Raster,
        // gibt amountStep "any" zurück, und ohne diese Prüfung wäre aus 12,5 JPY
        // anschliessend auch 12,555 JPY speicherbar.
        const offGrid = [
          [fields.daily_rate, dailyRate, visit.daily_rate],
          [fields.extras, extras, visit.extras],
        ].find(([field, value, original]) => field && value != null
          && !amountIsSavable(value, state.currency, { original: original ?? null }));
        if (offGrid) {
          window.yuvomi?.showToast(t('common.amountPrecisionRequired', {
            currency: state.currency,
            step: smallestUnitLabel(state.currency),
          }), 'danger');
          offGrid[0].focus();
          return;
        }
        let receiptDocumentId = visit.receipt_document_id || null;
        try {
          const file = panel.querySelector('#housekeeping-receipt-file')?.files?.[0];
          if (file) {
            if (file.size > maxUploadBytes()) throw new Error(t('documents.fileTooLarge', { size: maxUploadMb() }));
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
              folder_key: 'housekeeping',
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
          window.yuvomi?.showToast(t('housekeeping.visitSavedToast'), 'success');
          await loadData();
          state.staffLogMonth = dateValue.slice(0, 7);
          await loadStaffVisits();
          closeModal({ force: true });
          (onDone || renderStaff)(content);
        } catch (err) {
          window.yuvomi?.showToast(err.message, 'danger');
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
      const fmt = getNumberFormat({ style: 'currency', currency: state.currency || 'EUR' });
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
            <yuvomi-datepicker name="birth_date" type="date" value="${esc(item.birth_date || '')}"></yuvomi-datepicker>
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
            <input name="daily_rate" type="number" min="0" step="${amountStep(state.currency, item.daily_rate ?? 0)}"
                   placeholder="${amountPlaceholder(state.currency)}" inputmode="decimal" value="${esc(item.daily_rate ?? 0)}">
          </label>
          <label class="housekeeping-field" id="housekeeping-field-hourly-rate"${(!item.rate_type || item.rate_type === 'daily') ? ' hidden' : ''}>
            <span>${esc(t('housekeeping.hourlyRate'))}</span>
            <input name="hourly_rate" type="number" min="0" step="${amountStep(state.currency, item.hourly_rate ?? 0)}"
                   placeholder="${amountPlaceholder(state.currency)}" inputmode="decimal" value="${esc(item.hourly_rate ?? 0)}">
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
        // Bei einem Bestandssatz neben dem Raster liefert amountStep "any" -
        // sonst liesse sich der vorhandene Eintrag gar nicht mehr speichern.
        // Dieses "any" gilt aber fürs ganze Feld, also muss der neu eingegebene
        // Wert hier geprüft werden: sonst wäre aus 12,5 JPY auch 12,555 JPY
        // speicherbar, mehr Bruch als die feste Schrittweite je zuliess.
        const isHourly = fields.rate_type.value === 'hourly';
        const rateField = isHourly ? fields.hourly_rate : fields.daily_rate;
        const rateValue = Number(rateField?.value || 0);
        const rateOriginal = isHourly ? item.hourly_rate : item.daily_rate;
        // Nur der Satz zum gewählten Tarif-Typ zählt. Der andere wird unten
        // trotzdem mitgesendet - dort geht der gespeicherte Wert raus, nicht
        // eine liegengebliebene Eingabe: wer 12,5 als Tagessatz tippt und dann
        // auf Stundensatz umstellt, schriebe sonst den ungeprüften Rest weg.
        const inactiveField = isHourly ? fields.daily_rate : fields.hourly_rate;
        const inactiveOriginal = isHourly ? item.daily_rate : item.hourly_rate;
        if (inactiveField) inactiveField.value = String(inactiveOriginal ?? 0);
        if (!amountIsSavable(rateValue, state.currency, { original: rateOriginal ?? null })) {
          window.yuvomi?.showToast(t('common.amountPrecisionRequired', {
            currency: state.currency,
            step: smallestUnitLabel(state.currency),
          }), 'danger');
          rateField?.focus();
          return;
        }
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
          window.yuvomi?.showToast(t('housekeeping.workerSavedToast'), 'success');
          await loadData();
          closeModal({ force: true });
          if (typeof options.afterSave === 'function') options.afterSave();
          else renderStaff(content);
        } catch (err) {
          window.yuvomi?.showToast(err.message, 'danger');
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
    // Das Label zu verstecken genügt nicht: ein verstecktes Feld nimmt weiter an
    // der Formularprüfung des Browsers teil. Ein liegengebliebener Tagessatz von
    // 12,5 blockierte damit unter JPY (Schrittweite 1) das Speichern, ohne dass
    // irgendwo etwas zu sehen war - der Absenden-Knopf tat schlicht nichts.
    // `disabled` nimmt das Feld aus der Prüfung; sein Wert bleibt lesbar, und
    // der Speicherpfad liest ihn direkt über form.elements, nicht über FormData.
    const dailyInput = dailyRateField?.querySelector('input');
    const hourlyInput = hourlyRateField?.querySelector('input');
    if (dailyInput) dailyInput.disabled = isHourly;
    if (hourlyInput) hourlyInput.disabled = !isHourly;
  }
  rateTypeSelect?.addEventListener('change', updateRateFields);
  // Einmal beim Öffnen: das Markup setzt zwar `hidden`, aber nicht `disabled` -
  // ohne diesen Aufruf bliebe das inaktive Feld von Anfang an in der Prüfung.
  updateRateFields();

  const avatarFile = panel?.querySelector('#housekeeping-avatar-file');
  const avatarButton = panel?.querySelector('#housekeeping-avatar-btn');
  avatarButton?.addEventListener('click', () => avatarFile?.click());
  avatarFile?.addEventListener('change', async () => {
    const file = avatarFile.files?.[0];
    if (!file) return;
    // Das Feld ist ein Transportmittel, kein Zustand - sofort leeren, wie
    // beim Kachelbild (`quick-links-manager.js`). Bleibt der Dateiname
    // stehen, feuert `change` beim nächsten Griff zu DERSELBEN Datei nicht
    // mehr, und „nochmal anders zuschneiden" täte gar nichts.
    avatarFile.value = '';
    try {
      const { pickCroppedImage } = await import('/utils/avatar-crop.js');
      const cropped = await pickCroppedImage(file);
      if (cropped === undefined) return; // abgebrochen: bisheriges Bild bleibt
      state.workerAvatar = cropped;
      avatarButton.replaceChildren();
      avatarButton.insertAdjacentHTML('beforeend', `<img src="${esc(state.workerAvatar)}" alt="">`);
    } catch (err) {
      // Vorher verschwand hier JEDER Fehler in einem leeren `catch` - eine zu
      // große oder falsch getypte Datei sah aus wie ein Abbruch, und der
      // Reader warf ohnehin einen Error ohne Text. Jetzt gibt es eine Meldung.
      window.yuvomi?.showToast(err.message, 'danger');
    }
  });
  if (window.lucide) window.lucide.createIcons({ el: panel });
}

export async function render(container) {
  container.replaceChildren();
  container.insertAdjacentHTML('beforeend', `
    <section class="housekeeping-page app-page app-page--data housekeeping-page--loading" data-composition="data" aria-busy="true">
      ${renderSkeletonList({ rows: 6, lines: 2 })}
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
    // Vorher: Leerzustands-Markup ohne Rolle, ohne Ausweg - und als Erklaerung
    // der rohe `err.message`. Der ist bei allen Routen das unlokalisierte
    // englische „Internal server error." und hatte in einer uebersetzten
    // Oberflaeche nichts zu suchen. `mountLoadError` zeigt stattdessen den
    // sprachneutralen Statuscode und erzwingt den Wiederholen-CTA.
    container.replaceChildren();
    container.insertAdjacentHTML('beforeend',
      '<section class="housekeeping-page app-page app-page--data" data-composition="data"></section>');
    mountLoadError(container.querySelector('.housekeeping-page'), {
      title: t('housekeeping.loadError'),
      description: t('common.loadErrorDescription'),
      error: err,
      retryLabel: t('common.retry'),
      onRetry: () => render(container),
    });
  }
}
