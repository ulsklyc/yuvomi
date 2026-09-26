/**
 * Modul: Housekeeping
 * Zweck: Dashboard, chore management, reports, and housekeeping staff
 * Abhängigkeiten: /api.js, /i18n.js, /utils/html.js
 */

import { api, auth } from '/api.js';
import { t, formatDate, formatDayMonth, formatTime, getLocale, getNumberFormat } from '/i18n.js';
import { esc } from '/utils/html.js';
import { renderSkeletonList } from '/utils/skeleton.js';
import { emptyStateHTML, mountLoadError } from '/utils/empty-state.js';
import { openModal, closeModal, confirmModal, confirmOverModal, refocusAfterRender } from '/components/modal.js';
import { createPageFab, setPageFabAction } from '/utils/fab.js';
import { wireTablist } from '/utils/tablist.js';
import { wireScrollFade, vibrate, animationSettled } from '/utils/ux.js';
import { amountPlaceholder, amountStep, amountIsSavable, smallestUnitLabel } from '/utils/money.js';
import { maxUploadBytes, maxUploadMb } from '/utils/upload-limit.js';
import { isNavModuleReadOnly } from '/permissions.js';
import { pathAccess, mayWritePath } from '/utils/module-access.js';



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
  // Monat des Berichte-Tabs (#1137); null folgt dem laufenden Monat.
  reportMonth: null,
  currentMonth: null,
  recentVisits: [],
  templates: [],
  worker: null,
  workers: [],
  workerAvatar: undefined,
  selectedStaffId: null,
  staffLogMonth: localDate().slice(0, 7),
  staffVisits: [],
  currency: 'EUR',
};

// --------------------------------------------------------
// Nur-lesen (#467, #1265 P6)
// --------------------------------------------------------

/**
 * Darf dieser Nutzer in der Haushaltshilfe schreiben?
 *
 * Die VERBINDLICHE Sperre liegt am Server: das Gate an /api/v1 beantwortet
 * jedes POST/PUT/PATCH/DELETE unter /housekeeping mit 403, sobald das Modul auf
 * `read` steht. Dies ist die ehrliche UI-Entsprechung. Ohne sie trug die Seite
 * bei `read` fast jeden Schreibweg voll bedienbar - ein- und auschecken,
 * Aufgaben aus einer Vorlage oder dem Formular anlegen, abhaken, zuruecknehmen,
 * bearbeiten und loeschen, ein Profil aus dem Leerzustand anlegen -, und jeder
 * endete am 403. Die Besuchszeilen waren schon ehrlich: dort bietet der Server
 * je Besuch an (`can_edit`, `can_delete`, `can_mark_paid`, #1135/#1136) und
 * rechnet das Modulrecht mit ein (`mayWriteHousekeeping()` in
 * server/routes/housekeeping.js). Die Seite fragt dort trotzdem selbst, weil
 * ein Rechtewechsel ohne Neuladen ankommt und die Felder so alt sind wie die
 * letzte Antwort.
 *
 * `housekeeping` ist ein echter Rechte-Schluessel (server/permissions.js,
 * `NAV_TO_MODULE` in /permissions.js); `!mayWritePath('/housekeeping')` ist
 * dasselbe Urteil. Als Funktion und nicht als Konstante, damit jedes Neuzeichnen
 * neu fragt. Vorbild: `waste.js`, `health.js`.
 *
 * DREI LINIEN, weil diese Seite ihre Knoepfe einzeln verdrahtet:
 *   1. das Markup nimmt die Affordanz,
 *   2. `readOnlyLatch()` nimmt dem uebrig gebliebenen Knoten die Wirkung
 *      (Positivliste `READ_SAFE_CONTROLS`),
 *   3. die schreibende Verdrahtung haengt gar nicht erst, und jeder Einstieg
 *      (Dialog, Buchung, Check-in, Anlegen) fragt selbst noch einmal - auch
 *      beim Absenden eines Dialogs, der vor einem Rechtewechsel aufging.
 *
 * KEIN WANDTABLETT, KEIN PERSONAL. Ein Display fuehrt `housekeeping` nicht in
 * seiner Scope-Liste (server/display-scopes.js), bekommt das Modul deshalb als
 * `none` und erreicht diese Seite gar nicht; `DISPLAY_WRITE_ROUTES` nennt keine
 * Route hierher. Ein Konto der Haushaltshilfe selbst meldet sich auf keinem Weg
 * an (`canSignIn` in server/auth.js, #243). Ein `actingAsDisplay()` vor der
 * Modulregel braucht es hier also nicht.
 */
function readOnly() {
  return isNavModuleReadOnly('housekeeping');
}

/**
 * Die Bedienelemente dieser Seite, die NICHT schreiben. Alles andere sperrt
 * `readOnlyLatch()` bei `read`.
 *
 * Eine POSITIVLISTE wie `READ_SAFE_ACTIONS` in waste.js und health.js, nur aus
 * Selektoren statt Aktionsnamen: diese Seite hat keinen `data-action`-Verteiler,
 * jeder Knopf traegt seinen eigenen Haken. Eine Liste der schreibenden Haken
 * saehe zu jedem morgen ergaenzten Knopf Ja; so ist er gesperrt, bis ihn jemand
 * hier als lesend eintraegt.
 *
 * Tab wechseln, einen Einsatzbericht oeffnen (Uebersicht, Protokoll, Berichte),
 * das Profil einer Person lesen, eine Person fuer ihr Protokoll waehlen, den
 * Monat des Berichts oder des Protokolls wechseln. Verglichen wird das Bedienelement SELBST (`matches`),
 * nicht ein Vorfahr: die Personenzeile ist lesend, ihr Bearbeiten-Knopf nicht.
 */
const READ_SAFE_CONTROLS = [
  '.housekeeping-tab',
  '[data-open-visit]',
  '[data-visit-report]',
  '[data-open-worker]',
  '.housekeeping-staff-row__select',
  '#housekeeping-report-prev',
  '#housekeeping-report-next',
  '#housekeeping-report-current',
  '#housekeeping-staff-month',
].join(', ');

// Was als Bedienelement zaehlt. Ein `label` nicht: sein Klick kommt als eigener
// Klick am Feld an und wird dort beurteilt - sonst sperrte die Beschriftung des
// Monatsfilters den Filter.
const LATCHED_CONTROLS = 'button, input, select, textarea, form, [role="button"]';

/**
 * Der eine Riegel fuer alle Bedienelemente der Seite, in der ERFASSUNGSPHASE an
 * `.housekeeping-page` (Klick und Absenden, siehe `renderShell()`).
 *
 * WARUM CAPTURE: die Listener haengen an den Knoepfen selbst, nicht an einem
 * gemeinsamen Verteiler - ein Riegel in der Blasenphase kaeme zu spaet, der
 * Dialog stuende dann schon (dieselbe Begruendung wie in health.js). Die Dialoge
 * selbst liegen ausserhalb der Seite; sie fragen in ihrem Einstieg und beim
 * Absenden.
 */
function readOnlyLatch(event) {
  if (!readOnly()) return;
  const target = event.target;
  if (typeof target?.closest !== 'function') return;
  const control = target.closest(LATCHED_CONTROLS);
  if (!control || control.matches(READ_SAFE_CONTROLS)) return;
  event.preventDefault();
  event.stopPropagation();
}

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
  // Waehrend dieses Neuladens kann jemand schon den naechsten Monat gewaehlt
  // haben (#1137): kommt dessen Bericht zuerst an, darf die Antwort hier ihn
  // nicht mit dem alten Monat ueberschreiben. Scheitert der Schritt dagegen,
  // bleibt dieses Neuladen der neueste Stand und gilt (#1174).
  const reportSeq = ++reportFetchSeq;
  const reportMonth = state.reportMonth;
  const [dashboard, tasks, current, report, templates, workers, prefs] = await Promise.all([
    api.get('/housekeeping/dashboard'),
    api.get('/housekeeping/decay-tasks'),
    api.get('/housekeeping/visits'),
    // Der Berichte-Tab behaelt seinen Monat ueber jedes Neuladen (#1137). Jede
    // Aktion der Seite laedt hierueber nach; stuende der Monat nur im
    // Bedienelement, spraenge der Bericht nach dem ersten Bezahlen zurueck.
    reportMonth ? api.get(reportVisitsPath(reportMonth)) : null,
    api.get('/housekeeping/task-templates'),
    api.get(`/housekeeping/workers?${dayParams.toString()}`),
    api.get('/preferences'),
  ]);
  state.dashboard = dashboard.data;
  state.tasks = tasks.data || [];
  const currentReport = current.data || { visits: [], totals: {} };
  state.currentMonth = currentReport.month || localDate().slice(0, 7);
  // Die Uebersicht zeigt die juengsten Besuche, egal welchen Monat der
  // Berichte-Tab gerade offen hat.
  state.recentVisits = currentReport.visits || [];
  if (reportSeq > appliedReportSeq) {
    applyVisitReport(report ? report.data : currentReport);
    appliedReportSeq = reportSeq;
    // Der Stepper rechnet vom angezeigten Monat aus. Ist ein Schritt inzwischen
    // gescheitert, hat er den Monat auf den damals angezeigten zurueckgestellt,
    // und dieser Bericht zeigt womoeglich einen anderen (#1174). Laeuft dagegen
    // ein spaeter gestarteter Schritt noch, gehoert der Monat ihm: er wendet
    // seinen Bericht an oder stellt beim Scheitern auf diesen hier zurueck.
    if (!(reportStepInFlight > reportSeq)) state.reportMonth = reportMonth;
  }
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

// Kontext-FAB: folgt dem aktiven Tab. „Aufgaben" legt eine Aufgabe an (Dialog
// mit Vorlagen und Formular), „Personal" eine Person; „Übersicht"/„Berichte"
// haben keine Erstellen-Aktion → FAB dort ausgeblendet.
//
// DAS NOMEN FUER DEN DESKTOP-KOPF STEHT SCHON BEIM ANLEGEN AM KNOPF. Der
// Router dockt ihn genau einmal an (dockFabIntoToolbar, nach dem Rendern) und
// nur, wenn `data-dock-label` da ist - ein Tab ohne Aktion, der beim ersten
// Bild offen ist, darf es deshalb nicht loeschen, sonst schwebte der Knopf am
// Desktop fuer den Rest des Besuchs.
let fab = null;

function updateHousekeepingFab() {
  if (!fab) return;
  // Bei `read` blendet layout.css den FAB schon aus; hier faellt auch seine
  // Aktion weg - ausgeblendet ist nicht unerreichbar.
  const content = () => document.querySelector('#housekeeping-content');
  if (state.tab === 'tasks' && !readOnly()) {
    setPageFabAction(fab, {
      label: t('housekeeping.addTask'),
      dockLabel: t('newLabel.tasks'),
      onClick: () => openTaskCreateModal(content()),
    });
  } else if (state.tab === 'staff' && !readOnly()) {
    setPageFabAction(fab, {
      label: t('housekeeping.addWorker'),
      dockLabel: t('newLabel.housekeepingWorker'),
      onClick: () => openStaffModal(null, content()),
    });
  } else {
    setPageFabAction(fab, { hidden: true, dockLabel: fab.dataset?.dockLabel || t('newLabel.tasks') });
  }
}

function renderShell(container) {
  container.replaceChildren();
  // Kopf nach der Kopfregel (DESIGN.md): Zeile 1 Titel, Zeile 2 die Reiter.
  // Der Zeitraum des Berichte-Tabs steht im Center-Slot wie im Budget
  // (`page-toolbar--period`) - am Desktop in der Titelzeile, mobil als eigene
  // Zeile ueber den Reitern; auf den anderen Tabs ist der Slot leer und
  // verborgen (syncReportPeriod()).
  container.insertAdjacentHTML('beforeend', `
    <section class="housekeeping-page app-page app-page--data" data-composition="data" aria-labelledby="housekeeping-title">
      <header class="page-toolbar page-toolbar--narrow page-toolbar--wrap page-toolbar--period housekeeping-toolbar">
        <h1 class="page-toolbar__title" id="housekeeping-title">${esc(t('housekeeping.title'))}</h1>
        <div class="page-toolbar__center housekeeping-period" id="housekeeping-period" hidden></div>
        <div class="page-toolbar__actions"></div>
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

  fab = createPageFab({ id: 'housekeeping-fab', dockLabel: t('newLabel.tasks') });
  const page = container.querySelector('.housekeeping-page');
  page.appendChild(fab);
  // Der Riegel fuer jeden Knopf der Seite (siehe readOnlyLatch()). Er haengt an
  // der Seite, die hier jedes Mal neu entsteht, und damit auch am Kopf mit dem
  // Monats-Stepper des Berichte-Tabs.
  page.addEventListener('click', readOnlyLatch, true);
  page.addEventListener('submit', readOnlyLatch, true);

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
  // Der Zeitraum gehoert nur dem Berichte-Tab; renderReports() setzt ihn selbst.
  if (state.tab !== 'reports') syncReportPeriod(content);
  updateHousekeepingFab();
  if (window.lucide) window.lucide.createIcons({ el: container });
}

async function toggleSession(container, workerId) {
  if (readOnly()) return;
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
    // Nur den Tab neu zeichnen, nicht die Schale: ein neuer Kopf verloere den
    // FAB, den der Router einmal nach dem Rendern aus der Seite in die Shell
    // (bzw. am Desktop in den Kopf) gehoben hat - der neu angelegte bliebe im
    // Scrollport liegen, der alte mit veralteter Aktion in der Shell.
    renderCurrentTab(container);
  } catch (err) {
    window.yuvomi?.showToast(err.message, 'danger');
  }
}

/**
 * Der Check-Knopf einer Person bei `housekeeping: read` - die Antwort folgt dem
 * DATENSATZ.
 *
 * Der Knopf traegt zweierlei: die Handlung (ein- oder auschecken) und im
 * eingecheckten Zustand eine Auskunft, die sonst auf dieser Seite nirgends
 * steht. Die Zeile daneben nennt nur die Uhrzeit des Einsatzes und liest dafuer
 * auch eine schon beendete Sitzung von heute (`current_session` gegen
 * `today_session`, #1133) - ob die Person GERADE da ist, sagt allein der Knopf.
 *
 * Eine offene Sitzung bleibt deshalb als ZEICHEN stehen: ein `span role="img"`,
 * dessen Beschriftung den Zustand nennt, kein `disabled`-Knopf, der Treffer-
 * flaeche und Hover behielte und „Auschecken" fuer eine Beruehrung verspraeche,
 * die nichts tut. Ohne offene Sitzung faellt die Stelle ganz weg: „nicht
 * eingecheckt" ist kein Zustand, den ein leerer Knopf zeigen muesste.
 *
 * Der Wortlaut ist der der Uebersichts-Kachel (`dashboard.housekeepingPresent`),
 * die denselben Zustand aus derselben offenen Sitzung liest - ein Zustand, ein
 * Satz, in allen Sprachen schon uebersetzt.
 */
function presenceSignHtml(checkedIn) {
  if (!checkedIn) return '';
  const label = t('dashboard.housekeepingPresent');
  return `
      <span class="housekeeping-check-small housekeeping-check-small--static" role="img" aria-label="${esc(label)}">
        <i data-lucide="log-in" aria-hidden="true"></i>
        <span>${esc(label)}</span>
      </span>`;
}

function renderWorkerSummary() {
  if (!state.workers.length) {
    // Der Leerzustand bot „Profil anlegen" an; bei `read` faellt die Aktion
    // weg, die Auskunft bleibt.
    return emptyStateHTML({
      icon: 'user-plus',
      title: t('housekeeping.noWorkerTitle'),
      description: t('housekeeping.noWorkerHint'),
      action: readOnly() ? null : {
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
      ${readOnly() ? presenceSignHtml(checkedIn) : `
      <button class="btn ${checkedIn ? 'btn--secondary' : 'btn--primary'} housekeeping-check-small" type="button"
              data-worker-check="${worker.id}">
        <i data-lucide="${checkedIn ? 'log-out' : 'log-in'}" aria-hidden="true"></i>
        <span>${esc(checkedIn ? t('housekeeping.checkOut') : t('housekeeping.checkIn'))}</span>
      </button>`}
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

  const recentVisits = (state.recentVisits || []).slice(0, 5);
  const recentRows = recentVisits.map((visit) => `
    <article class="list-row housekeeping-staff-log-row">
      <div class="list-row__main">
        <div class="list-row__name">${esc(formatDate(visit.check_in))}</div>
        <div class="list-row__meta">${esc(visit.worker_name || t('housekeeping.staff'))} · ${esc(money(visit.total_amount))} · ${esc(visitPaymentMeta(visit))}</div>
      </div>
      <div class="list-row__actions">
        ${visitEditActionHtml(visit, formatDate(visit.check_in))}
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
  // `if (!readOnly())` statt `return`: die lesende Verdrahtung (Bericht
  // oeffnen) steht dahinter und muss bleiben - dieselbe Form wie in health.js.
  if (!readOnly()) {
    content.querySelectorAll('[data-worker-check]').forEach((btn) => {
      btn.addEventListener('click', () => toggleSession(document.querySelector('.page-transition') || document.body, btn.dataset.workerCheck));
    });
    content.querySelectorAll('[data-edit-visit]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const visit = (state.recentVisits || []).find((v) => String(v.id) === btn.dataset.editVisit);
        if (visit) openVisitEditModal(visit, content, { onDone: renderDashboard });
      });
    });
  }
  content.querySelectorAll('[data-open-visit]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const visit = (state.recentVisits || []).find((v) => String(v.id) === btn.dataset.openVisit);
      if (visit) openVisitReportModal(visit, null, { onRefresh: () => { if (content.isConnected) renderDashboard(content); } });
    });
  });
}

/**
 * Legt eine Aufgabe an. Gibt zurueck, ob es geklappt hat - der Anlegedialog
 * schliesst nur dann; scheitert es, bleibt er mit der Eingabe stehen.
 */
async function createTask(payload, content) {
  if (readOnly()) return false;
  try {
    await api.post('/housekeeping/decay-tasks', payload);
    window.yuvomi?.showToast(t('housekeeping.taskCreatedToast'), 'success');
    await loadData();
    if (content?.isConnected && state.tab === 'tasks') renderTasks(content);
    return true;
  } catch (err) {
    window.yuvomi?.showToast(err.message, 'danger');
    return false;
  }
}

/**
 * Eine Aufgabenzeile in der Listengrammatik (list-row.css): Kreis | Titel +
 * Meta | Aktionen. Bei `housekeeping: read` bleibt die AUSKUNFT - Name,
 * Bereich, Rhythmus und die Dringlichkeit (Toenung und Beschriftung) -, und
 * alle Bedienelemente fallen weg: der Kreis links, das Bearbeiten und das
 * Loeschen.
 *
 * DER KREIS IST KEIN ZUSTAND. Anders als der Haken einer Aufgabe
 * (`.task-status-btn--static`) sieht er an jeder Zeile gleich aus - er heisst
 * „jetzt erledigt" und setzt die Frist zurueck, sagt aber nicht, ob etwas
 * erledigt ist. Deshalb ist er ein LEERER Ring: der gefuellte Kreis mit Haken
 * las sich an jeder Zeile wie „schon erledigt" (Critique 2026-09-26, A3). Den
 * Zustand der Zeile traegt die Dringlichkeit, und die bleibt. Ohne Kreis rueckt
 * der Text an die Kante; eine reservierte Spalte gibt es in der Flex-Zeile nicht.
 *
 * „OK" STEHT NICHT IN DER ZEILE. Nur ein faelliger Zustand hat etwas zu sagen
 * (heute, ueberfaellig) - ein Wort an jeder ruhigen Zeile war Rauschen.
 *
 * KEIN ZURUECKNEHMEN-KNOPF MEHR IN DER ZEILE. Er setzte `last_completed` auf
 * leer statt auf den Stand davor und nahm dem Titel mobil 48px. Das Erledigen
 * meldet sich jetzt mit einem Toast samt „Rueckgaengig", der den vorherigen
 * Zeitpunkt wiederherstellt (completeTask()).
 */
function taskRowHtml(task) {
  const ro = readOnly();
  const due = task.urgency_status === 'overdue' || task.urgency_status === 'today';
  return `
    <article class="list-row housekeeping-task housekeeping-task--${esc(task.urgency_status)}${ro ? ' housekeeping-task--readonly' : ''}">
      ${ro ? '' : `
      <button class="housekeeping-task__check" type="button" data-complete-task="${esc(task.id)}"
              aria-label="${esc(t('housekeeping.completeTask', { name: task.name }))}">
        <i data-lucide="check" aria-hidden="true"></i>
      </button>`}
      <div class="list-row__main housekeeping-task__body">
        <h2 class="list-row__name">${esc(task.name)}</h2>
        <p class="list-row__meta">${due ? `<span class="housekeeping-task__status">${esc(urgencyLabel(task.urgency_status))}</span> · ` : ''}${esc(task.area)} · ${esc(t('housekeeping.everyDays', { days: task.frequency_days }))}</p>
      </div>
      ${ro ? '' : `
      <div class="list-row__actions housekeeping-task__actions">
        <button class="row-action" type="button" data-edit-task="${esc(task.id)}"
                aria-label="${esc(t('housekeeping.editTask'))}">
          <i data-lucide="edit-2" class="icon-md" aria-hidden="true"></i>
        </button>
        <button class="row-action row-action--danger" type="button" data-delete-task="${esc(task.id)}"
                aria-label="${esc(t('housekeeping.deleteTask'))}">
          <i data-lucide="trash-2" class="icon-md" aria-hidden="true"></i>
        </button>
      </div>`}
    </article>
  `;
}

/**
 * Der Anlegedialog des Aufgaben-Tabs, hinter dem FAB (mobil) bzw. der
 * Kopf-Pille (Desktop).
 *
 * VORHER standen Vorlagen-Karussell und Formular dauerhaft VOR der Liste: mobil
 * lag die erste Aufgabe bei y=758 von 844, also unter dem Falz - Anlegen (selten)
 * verdraengte Abhaken (haeufig) (Critique 2026-09-26, A3 P1-1). Jetzt ist die
 * Liste der Tab, und das Anlegen ein Dialog: oben die Vorlagen als
 * Schnellauswahl - ein Tipp legt die Aufgabe an, wie vorher im Karussell -,
 * darunter das eigene Formular.
 *
 * Beide Wege legen nur an; bei `housekeeping: read` oeffnet der Dialog gar
 * nicht (der FAB ist dann ohnehin weg, und der `n`-Kurzbefehl fragt dasselbe).
 */
function openTaskCreateModal(content) {
  if (readOnly()) return;
  // Eine Vorlage, die schon als Aufgabe in der Liste steht, schlaegt nichts
  // mehr vor: in einem eingerichteten Haushalt standen sonst alle acht
  // Vorschlaege da, und das eigene Formular lag unter dem Falz des Dialogs.
  // Der Index bleibt der in `state.templates` - der Klick liest ihn dort.
  const existing = new Set(state.tasks.map((task) => String(task.name || '').trim().toLocaleLowerCase()));
  const templateButtons = state.templates.map((template, index) => (
    existing.has(templateLabel(template, 'name').trim().toLocaleLowerCase()) ? '' : `
          <button class="housekeeping-template" type="button" data-template-index="${index}">
            <span class="housekeeping-template__name">${esc(templateLabel(template, 'name'))}</span>
            <small>${esc(templateLabel(template, 'area'))} · ${esc(t('housekeeping.everyDays', { days: template.frequency_days }))}</small>
          </button>`)).join('');
  openModal({
    title: t('housekeeping.addTask'),
    size: 'md',
    content: `
      <div class="housekeeping-create">
        ${templateButtons ? `
        <section class="housekeeping-create__templates" aria-labelledby="housekeeping-templates-title">
          <h3 class="housekeeping-create__heading" id="housekeeping-templates-title">${esc(t('housekeeping.taskTemplates'))}</h3>
          <div class="housekeeping-template-list">${templateButtons}
          </div>
        </section>` : ''}
        <form id="housekeeping-task-form" class="housekeeping-task-form" aria-labelledby="housekeeping-custom-title">
          <h3 class="housekeeping-create__heading" id="housekeeping-custom-title">${esc(t('housekeeping.addCustomTask'))}</h3>
          <label class="housekeeping-field">
            <span>${esc(t('housekeeping.taskName'))}</span>
            <input name="name" required maxlength="200" autocomplete="off" placeholder="${esc(t('housekeeping.taskNamePlaceholder'))}">
          </label>
          <div class="housekeeping-form-grid housekeeping-form-grid--pair">
            <label class="housekeeping-field">
              <span>${esc(t('housekeeping.taskArea'))}</span>
              <input name="area" required maxlength="100" autocomplete="off" placeholder="${esc(t('housekeeping.taskAreaPlaceholder'))}">
            </label>
            <label class="housekeeping-field">
              <span>${esc(t('housekeeping.taskFrequency'))}</span>
              <input name="frequency_days" required inputmode="numeric" type="number" min="1" step="1" value="7">
            </label>
          </div>
          <div class="modal-panel__footer">
            <button class="btn btn--secondary" type="button" data-create-cancel>${esc(t('common.cancel'))}</button>
            <button class="btn btn--primary" type="submit">${esc(t('housekeeping.createTask'))}</button>
          </div>
        </form>
      </div>
    `,
    // Die Vorlagen stehen zuerst; der Fokus springt trotzdem nicht ins
    // Namensfeld, sonst ginge mobil die Tastatur ueber die Schnellauswahl auf.
    initialFocus: 'none',
    onSave: (panel) => {
      let busy = false;
      const run = async (payload) => {
        // Doppeltipp auf eine Vorlage legte sie zweimal an.
        if (busy || readOnly()) return;
        busy = true;
        const ok = await createTask(payload, content);
        busy = false;
        if (ok) closeModal({ force: true });
      };
      panel.querySelectorAll('[data-template-index]').forEach((btn) => {
        btn.addEventListener('click', () => {
          const template = state.templates[Number(btn.dataset.templateIndex)];
          if (!template) return;
          run({
            name: templateLabel(template, 'name'),
            area: templateLabel(template, 'area'),
            frequency_days: template.frequency_days,
          });
        });
      });
      panel.querySelector('[data-create-cancel]')?.addEventListener('click', () => closeModal());
      panel.querySelector('#housekeeping-task-form')?.addEventListener('submit', (event) => {
        event.preventDefault();
        const fields = event.currentTarget.elements;
        const frequencyDays = Number(fields.frequency_days.value);
        if (!fields.name.value.trim() || !fields.area.value.trim() || !Number.isInteger(frequencyDays) || frequencyDays < 1) return;
        run({
          name: fields.name.value.trim(),
          area: fields.area.value.trim(),
          frequency_days: frequencyDays,
        });
      });
    },
  });
}

/**
 * Erledigen mit Rueckweg: der Toast traegt „Rueckgaengig", und das stellt den
 * Zeitpunkt der VORHERIGEN Erledigung wieder her (`last_completed` zurueck auf
 * den alten Wert, bei einer nie erledigten Aufgabe auf leer). Der Server nimmt
 * beide gespeicherten Formen unveraendert an (Instant mit `Z` bleibt Instant,
 * zonenlose Wanduhrzeit bleibt Wanduhrzeit, validate.js `to: 'instant'`).
 */
async function completeTask(task, content, button = null) {
  if (readOnly()) return;
  if (button?.getAttribute('aria-busy') === 'true') return;
  const previous = task.last_completed ?? null;
  // DIESELBE RUECKMELDUNG WIE DAS ABHAKEN EINER AUFGABE (Critique 2026-09-26,
  // A3 P1-4): Haptik und `check-pop` im Moment des Tipps, nicht erst nach dem
  // Roundtrip - vorher quittierte nur der Toast, ohne Bewegung und ohne
  // Haptik. Der Ring fuellt sich fuer diesen Moment (`--done`); das
  // Neuzeichnen danach setzt ihn zurueck, denn der Kreis ist kein Zustand
  // (taskRowHtml()). Wie in tasks.js laeuft die Quittung NEBEN dem Roundtrip,
  // und erst danach wird neu gezeichnet - sonst ersetzte das Neuzeichnen den
  // Knopf, bevor sie einen Frame bekam (animationSettled()).
  vibrate(15);
  button?.classList.add('housekeeping-task__check--done');
  button?.setAttribute('aria-busy', 'true');
  const settled = animationSettled(button);
  try {
    await api.post(`/housekeeping/decay-tasks/${task.id}/complete`, {});
    window.yuvomi?.showToast(t('housekeeping.taskDoneToast'), 'success', 5000, () => undoCompleteTask(task.id, previous, content));
    await settled;
    await loadData();
    if (content?.isConnected && state.tab === 'tasks') renderTasks(content);
  } catch (err) {
    button?.classList.remove('housekeeping-task__check--done');
    button?.removeAttribute('aria-busy');
    window.yuvomi?.showToast(err.message, 'danger');
  }
}

async function undoCompleteTask(taskId, previous, content) {
  if (readOnly()) return;
  try {
    await api.patch(`/housekeeping/decay-tasks/${taskId}`, { last_completed: previous });
    window.yuvomi?.showToast(t('housekeeping.taskUndoneToast'), 'success');
    await loadData();
    if (content?.isConnected && state.tab === 'tasks') renderTasks(content);
  } catch (err) {
    window.yuvomi?.showToast(err.message, 'danger');
  }
}

/**
 * Der Aufgaben-Tab ist die LISTE, sonst nichts: Anlegen sitzt hinter dem FAB
 * (openTaskCreateModal()). Der Leerzustand bietet denselben Weg an.
 */
function renderTasks(content) {
  content.replaceChildren();
  const taskRows = state.tasks.map(taskRowHtml).join('');
  const empty = emptyStateHTML({
    icon: 'list-checks',
    title: t('housekeeping.noTasks'),
    ...(readOnly() ? {} : { action: { label: t('housekeeping.addTask'), icon: 'plus', attrs: { 'data-create-task': '' } } }),
  });

  content.insertAdjacentHTML('beforeend', `
    <section class="housekeeping-task-list row-carrier" aria-label="${esc(t('housekeeping.tasks'))}">
      ${taskRows || empty}
    </section>
  `);
  if (window.lucide) window.lucide.createIcons({ el: content });
  // Jede Verdrahtung darunter schreibt - bei `read` haengt keine.
  if (readOnly()) return;

  content.querySelector('[data-create-task]')?.addEventListener('click', () => openTaskCreateModal(content));

  content.querySelectorAll('[data-complete-task]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const task = state.tasks.find((it) => String(it.id) === btn.dataset.completeTask);
      if (task) completeTask(task, content, btn);
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
  if (readOnly()) return;
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
  if (readOnly()) return;
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

/* Bearbeiten und Loeschen bietet eine Besuchszeile nur an, wenn der Server es
 * fuer genau diesen Besuch zugesteht (`can_edit`, `can_delete`, #1135). Vorher
 * standen beide Knoepfe an jeder Zeile, und ein Mitglied lernte erst beim
 * Speichern, dass ein bezahlter Besuch abgerechnet ist. Die Admin-Regel wird
 * hier nicht nachgebaut. Wo Bearbeiten fehlt, fuehrt der Knopf zum Bericht:
 * lesen darf jede Person, die die Zeile sieht.
 *
 * `readOnly()` steht ZUSAETZLICH da (#1265 P6). Der Server rechnet das
 * Modulrecht schon in die Felder ein, aber die Felder sind so alt wie die
 * letzte Antwort, und ein Rechtewechsel kommt ohne Neuladen an. */
function visitEditActionHtml(visit, visitDate) {
  if (visit.can_edit && !readOnly()) {
    return `<button class="row-action" type="button" data-edit-visit="${esc(visit.id)}"
                aria-label="${esc(t('housekeeping.editVisit'))}: ${esc(visitDate)}">
          <i data-lucide="edit-2" class="icon-md" aria-hidden="true"></i>
        </button>`;
  }
  return `<button class="row-action" type="button" data-open-visit="${esc(visit.id)}"
                aria-label="${esc(t('housekeeping.openVisitReport'))}: ${esc(visitDate)}">
          <i data-lucide="file-text" class="icon-md" aria-hidden="true"></i>
        </button>`;
}

function visitDeleteActionHtml(visit, visitDate) {
  if (!visit.can_delete || readOnly()) return '';
  return `<button class="row-action row-action--danger" type="button" data-delete-visit="${esc(visit.id)}"
                aria-label="${esc(t('housekeeping.deleteVisit'))}: ${esc(visitDate)}">
          <i data-lucide="trash-2" class="icon-md" aria-hidden="true"></i>
        </button>`;
}

/* Warum die Knoepfe fehlen, steht in der Metazeile, wo der Zahlstatus die
 * Zeile ohnehin beschreibt - nicht als Tooltip an einem Knopf, den es nicht gibt.
 * Bei `housekeeping: read` ist „nur durch einen Admin" nicht der Grund: dort
 * fehlen die Knoepfe an JEDEM Besuch, bezahlt oder nicht. Die Zeile nennt dann
 * nur den Zahlstatus. */
function visitPaymentMeta(visit) {
  if (!visit.paid_at) return t('housekeeping.paymentPending');
  if (visit.can_edit || readOnly()) return t('housekeeping.paymentPaid');
  return `${t('housekeeping.paymentPaid')} · ${t('housekeeping.settledAdminOnly')}`;
}

function currentMonthKey() {
  return state.currentMonth || localDate().slice(0, 7);
}

function shiftMonth(ym, dir) {
  const [year, monthIndex] = ym.split('-').map(Number);
  const d = new Date(year, monthIndex - 1 + dir, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function reportVisitsPath(monthValue) {
  return `/housekeeping/visits?month=${encodeURIComponent(monthValue)}`;
}

function applyVisitReport(data) {
  state.visitReport = data || { visits: [], totals: {} };
  state.reports = state.visitReport.visits || [];
}

/* Monats-Stepper des Berichte-Tabs (#1137) in der Grammatik, die Budget
 * vorgibt und #1164 fuer Kalender und Mahlzeiten uebernimmt: Pfeil, Monat,
 * Pfeil, dahinter der Reset, und der Reset ist im laufenden Monat verborgen.
 * Die Pfeile beschreiben sich ueber den Monat, damit ein Screenreader nach dem
 * Schritt auch sagt, wo er gelandet ist.
 *
 * IM KOPF, NICHT IN DER KARTE (Critique 2026-09-26, A3 P2-4). Der Zeitraum
 * beantwortet beim Scrollen weiter „welcher Monat", wie im Budget; in der Karte
 * scrollte er mit der Kennzahl-Zeile weg. Er steht im Center-Slot des Kopfs
 * (#housekeeping-period, renderShell()).
 *
 * VERBORGEN PER `.is-current` + `inert`, NICHT PER `hidden` - dieselbe Regel
 * wie Budget und Kalender (#1200): `hidden` nahm den Reset aus dem Fluss, das
 * Label wuchs in den freien Platz, und der Weiter-Pfeil ruckte um die
 * Knopfbreite, sobald man den laufenden Monat verliess. */
function reportMonthNavHtml(shownMonth, isCurrentMonth) {
  return `
          <button class="btn btn--icon" type="button" id="housekeeping-report-prev"
                  aria-label="${esc(t('housekeeping.prevMonth'))}" aria-describedby="housekeeping-report-month">
            <i data-lucide="chevron-left" aria-hidden="true"></i>
          </button>
          <span class="housekeeping-month-nav__label" id="housekeeping-report-month">${esc(formatMonthLabel(shownMonth))}</span>
          <button class="btn btn--icon" type="button" id="housekeeping-report-next"
                  aria-label="${esc(t('housekeeping.nextMonth'))}" aria-describedby="housekeeping-report-month">
            <i data-lucide="chevron-right" aria-hidden="true"></i>
          </button>
          <button class="btn btn--secondary housekeeping-month-nav__current${isCurrentMonth ? ' is-current' : ''}" type="button"
                  id="housekeeping-report-current"${isCurrentMonth ? ' inert' : ''}>${esc(t('housekeeping.currentMonth'))}</button>`;
}

/** Der Zeitraum-Slot im Kopf der Seite, zu der `content` gehoert. */
function reportPeriodSlot(content) {
  return content?.closest?.('.housekeeping-page')?.querySelector('#housekeeping-period') ?? null;
}

/**
 * Stellt den Zeitraum im Kopf auf den Tab ein: im Berichte-Tab der Stepper
 * des angezeigten Monats, sonst ein leerer, verborgener Slot.
 *
 * Steht der Stepper schon, werden nur Label und Reset nachgezogen, nicht die
 * Knoepfe neu gebaut: sonst verloere der Pfeil, auf dem jemand gerade den Monat
 * schaltet, nach jedem Schritt den Fokus.
 */
function syncReportPeriod(content) {
  const slot = reportPeriodSlot(content);
  if (!slot) return null;
  if (state.tab !== 'reports') {
    slot.replaceChildren();
    slot.hidden = true;
    return slot;
  }
  const shownMonth = state.visitReport?.month || currentMonthKey();
  const isCurrentMonth = shownMonth === currentMonthKey();
  const label = slot.querySelector('#housekeeping-report-month');
  const reset = slot.querySelector('#housekeeping-report-current');
  if (label && reset) {
    label.textContent = formatMonthLabel(shownMonth);
    // Hatte der Reset den Fokus, holt ihn vorher der Zurueck-Pfeil - `inert`
    // wirft ihn sonst auf <body>.
    if (isCurrentMonth && document.activeElement === reset) slot.querySelector('#housekeeping-report-prev')?.focus();
    reset.classList.toggle('is-current', isCurrentMonth);
    reset.inert = isCurrentMonth;
  } else {
    slot.replaceChildren();
    slot.insertAdjacentHTML('beforeend', reportMonthNavHtml(shownMonth, isCurrentMonth));
    slot.querySelector('#housekeeping-report-prev')?.addEventListener('click', () => stepReportMonth(content, -1));
    slot.querySelector('#housekeeping-report-next')?.addEventListener('click', () => stepReportMonth(content, 1));
    slot.querySelector('#housekeeping-report-current')?.addEventListener('click', () => (
      showReportMonth(content, currentMonthKey(), 'housekeeping-report-current')
    ));
    if (window.lucide) window.lucide.createIcons({ el: slot });
  }
  slot.hidden = false;
  return slot;
}

let reportMonthRequest = 0;

/* Welcher Bericht gilt, entscheidet der START seines Abrufs, nicht die Art
 * (#1174). Schritte und Neuladen ziehen dieselbe Nummer, und angewandt wird nur
 * eine Antwort, die spaeter gestartet ist als der Bericht, der gerade gilt.
 * Vorher verwarf loadData() seine Antwort, sobald irgendein Schritt BEGONNEN
 * hatte - auch einer, der danach scheiterte: der Bericht fiel auf den Stand vor
 * dem Bezahlen zurueck. Umgekehrt ueberschrieb ein vor der Aktion gestarteter
 * Schritt das spaetere Neuladen. Beides faengt der Startzeitpunkt. */
let reportFetchSeq = 0;
let appliedReportSeq = 0;
// Nummer des juengsten Schritts, solange er laeuft; ein ueberholter Schritt
// raeumt sie nicht, und ein veralteter Wert ist kleiner als jedes spaetere Neuladen.
let reportStepInFlight = 0;

/* Der gewaehlte Monat ist SEITENZUSTAND (#1137): loadData() liest ihn bei
 * jedem Neuladen. Gesetzt wird er vor dem Abruf, damit zwei schnelle Schritte
 * zwei Monate weit gehen; eine Antwort, die ein spaeterer Klick schon
 * ueberholt hat, wird verworfen, und ein Fehler stellt den Monat zurueck. */
async function showReportMonth(content, monthValue, focusId = null) {
  state.reportMonth = monthValue === currentMonthKey() ? null : monthValue;
  const request = ++reportMonthRequest;
  const seq = ++reportFetchSeq;
  reportStepInFlight = seq;
  try {
    const res = await api.get(reportVisitsPath(monthValue));
    if (request !== reportMonthRequest) return;
    reportStepInFlight = 0;
    // Ein Neuladen, das NACH diesem Schritt gestartet ist, hat denselben Monat
    // schon frischer angewandt: dann bleibt dessen Stand, gerendert wird trotzdem.
    if (seq > appliedReportSeq) {
      applyVisitReport(res.data || { month: monthValue, visits: [], totals: {} });
      appliedReportSeq = seq;
    }
    if (!content?.isConnected || state.tab !== 'reports') return;
    renderReports(content);
    // Der Reset verschwindet im laufenden Monat - dann bleibt der Fokus am
    // vorherigen Pfeil statt auf <body> zu fallen. Der Stepper steht im Kopf.
    const head = reportPeriodSlot(content) ?? content;
    const target = focusId ? head.querySelector(`#${focusId}`) : null;
    (target && !target.inert ? target : head.querySelector('#housekeeping-report-prev'))
      ?.focus({ preventScroll: true });
  } catch (err) {
    if (request !== reportMonthRequest) return;
    reportStepInFlight = 0;
    // Zurueck auf den Monat, den der Bericht ZEIGT - nicht auf den Wert vor
    // diesem Aufruf: bei zwei schnellen Schritten war das schon das Ziel des
    // ersten, dessen Antwort verworfen wurde, und Anzeige und Stepper liefen
    // auseinander.
    const shown = state.visitReport?.month || currentMonthKey();
    state.reportMonth = shown === currentMonthKey() ? null : shown;
    window.yuvomi?.showToast(err.message, 'danger');
  }
}

function stepReportMonth(content, dir) {
  const base = state.reportMonth || currentMonthKey();
  return showReportMonth(content, shiftMonth(base, dir),
    dir < 0 ? 'housekeeping-report-prev' : 'housekeeping-report-next');
}

/**
 * Der Berichte-Tab: die drei Kennzahlen des Monats, darunter die Besuche als
 * Zeilen. Den Monat waehlt der Stepper im Kopf (syncReportPeriod()).
 *
 * DIE KENNZAHLEN SIND DIE DER UEBERSICHT (`.metric-card`), nicht mehr die
 * graue `--inset`-Fassung in einer Karte: zwei KPI-Looks im selben Modul
 * (Critique 2026-09-26, A3 P2-4), und die Karte trug nur noch Ueberschrift und
 * Stepper, seit der Stepper im Kopf steht.
 *
 * DIE BESUCHSZEILE IST EINE `.list-row` wie im Personal-Protokoll: Avatar |
 * Name + Datum, Betrag, Status | Aktionen. Vorher stand „Als bezahlt
 * markieren" als beschrifteter Knopf in der Zeile und der Bericht-Knopf
 * darunter in einer eigenen - mobil 197px pro Besuch. Bezahlen ist jetzt
 * dieselbe `.row-action` wie im Protokoll (`badge-dollar-sign`), beschriftet
 * per `aria-label` mit dem Datum der Zeile. Sichtbar steht das Datum ohne
 * Jahr: den Monat samt Jahr nennt der Stepper im Kopf, und mit Jahr brach die
 * Metazeile mobil um. Das `aria-label` behaelt das volle Datum.
 */
function renderReports(content) {
  content.replaceChildren();
  const totals = state.visitReport?.totals || {};
  const visits = state.reports || [];
  const shownMonth = state.visitReport?.month || currentMonthKey();
  const isCurrentMonth = shownMonth === currentMonthKey();
  const rows = visits.map((visit) => {
    const paid = !!visit.paid_at;
    const visitDate = formatDate(visit.check_in);
    return `
    <article class="list-row list-row--tight housekeeping-report-item housekeeping-report-item--visit">
      <div class="housekeeping-avatar housekeeping-avatar--row" style="background:${esc(visit.worker_avatar_color) || 'var(--module-housekeeping)'}">
        ${visit.worker_avatar_data ? `<img src="${esc(visit.worker_avatar_data)}" alt="${esc(visit.worker_name || '')}">` : esc(initials(visit.worker_name || 'HK'))}
      </div>
      <div class="list-row__main">
        <div class="list-row__name">${esc(visit.worker_name || t('housekeeping.staff'))}</div>
        <div class="list-row__meta">${esc(formatDayMonth(visit.check_in))} · ${esc(money(visit.total_amount))} · ${esc(paid ? t('housekeeping.paymentPaid') : t('housekeeping.paymentPending'))}</div>
      </div>
      <div class="list-row__actions">
        ${!visit.can_mark_paid || readOnly() ? '' : `
        <button class="row-action" type="button" data-pay-report="${visit.id}"
                aria-label="${esc(t('housekeeping.markPaid'))}: ${esc(visitDate)}">
          <i data-lucide="badge-dollar-sign" class="icon-md" aria-hidden="true"></i>
        </button>`}
        <button class="row-action" type="button" data-visit-report="${visit.id}"
                aria-label="${esc(t('housekeeping.openVisitReport'))}: ${esc(visitDate)}">
          <i data-lucide="file-text" class="icon-md" aria-hidden="true"></i>
        </button>
      </div>
    </article>
  `;
  }).join('');

  content.insertAdjacentHTML('beforeend', `
    <section class="metric-grid" aria-label="${esc(t('housekeeping.visitReports'))}">
      <article class="metric-card">
        <div class="metric-card__label">${esc(t('housekeeping.reportVisitsCount'))}</div>
        <div class="metric-card__value">${esc(visits.length)}</div>
      </article>
      <article class="metric-card">
        <div class="metric-card__label">${esc(t('housekeeping.pendingPayments'))}</div>
        <div class="metric-card__value">${esc(money(totals.pending || 0))}</div>
      </article>
      <article class="metric-card">
        <div class="metric-card__label">${esc(t('housekeeping.paymentPaid'))}</div>
        <div class="metric-card__value">${esc(money(totals.paid || 0))}</div>
      </article>
    </section>
    <section class="housekeeping-reports${rows ? ' row-carrier' : ''}" aria-label="${esc(t('housekeeping.recentReports'))}">
      ${rows || `<p class="housekeeping-muted">${esc(isCurrentMonth
    ? t('housekeeping.noVisitReports')
    : t('housekeeping.noVisitReportsInMonth', { month: formatMonthLabel(shownMonth) }))}</p>`}
    </section>
  `);
  if (window.lucide) window.lucide.createIcons({ el: content });
  syncReportPeriod(content);

  content.querySelectorAll('[data-visit-report]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const visit = visits.find((item) => String(item.id) === btn.dataset.visitReport);
      if (visit) openVisitReportModal(visit, content);
    });
  });

  // Bezahlen direkt an der Ausstehend-Zeile (Audit R2, A2-14): derselbe Flow
  // wie im Personal-Einsatzlog, hier gegen die Berichtsliste. Bei `read`
  // haengt er nicht - Monatswahl und Bericht lesen nur.
  if (readOnly()) return;
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

/* DER EINSATZBERICHT IST DIE LESEANSICHT EINES BESUCHS (#1265 P6). Bei
 * `housekeeping: read` - und an einem abgerechneten Besuch schon seit #1135 -
 * fuehrt jeder Weg zu einem Besuch hierher statt in den Einsatz-Dialog. Was
 * nur der Dialog zeigte, stand damit nirgends: die Arbeitszeit eines Besuchs
 * nach Stunden und der Beleg. Beides steht jetzt auch hier, in der Form, die der
 * Dialog ihm gibt: nach Stunden die Minuten und der daraus berechnete Betrag,
 * sonst der Tagessatz. */
function visitWorkDetailsHtml(visit) {
  if (visit.rate_type === 'hourly') {
    return `
          <div><dt>${esc(t('housekeeping.minutesWorked'))}</dt><dd>${esc(visit.minutes_worked ?? 0)}</dd></div>
          <div><dt>${esc(t('housekeeping.computedAmount'))}</dt><dd>${esc(money(visit.daily_rate))}</dd></div>`;
  }
  return `
          <div><dt>${esc(t('housekeeping.dailyRate'))}</dt><dd>${esc(money(visit.daily_rate))}</dd></div>`;
}

/* Der Beleg im Bericht - so weit das Dokumentenrecht das Lesen erlaubt, dieselbe
 * Stufe wie im Einsatz-Dialog (`receiptFieldHtml()`): bei `documents: none`
 * antwortet schon das Lesen mit 403, dort steht er nicht. Gesetzt heisst
 * sichtbar, ein Besuch ohne Beleg hat keine Zeile dafuer. */
function visitReceiptDetailHtml(visit) {
  if (pathAccess('/documents') === 'none') return '';
  if (receiptHiddenFromViewer(visit)) {
    return `
          <div><dt>${esc(t('housekeeping.receiptLabel'))}</dt><dd>${esc(t('documentAttach.lockedPrivate'))}</dd></div>`;
  }
  if (!visit.receipt_document_name) return '';
  return `
          <div><dt>${esc(t('housekeeping.receiptLabel'))}</dt><dd>${esc(visit.receipt_document_name)}</dd></div>`;
}

/* Der Besuch hat einen Beleg, den der Server diesem Betrachter nicht nennt
 * (#1358): ein privates Dokument einer anderen Person. `has_receipt` gehoert
 * dem Besuch, Name und ID dem Dokumente-Modul - beide kommen dann als `null`.
 * Die Stelle zeigt nur, DASS es ihn gibt, ohne Ablage zum Ersetzen: der Server
 * nimmt einen unsichtbaren Beleg weder weg noch tauscht er ihn, und das
 * Speichern schickt `null`, was dort "behalten" heisst. Gefragt wird nach der
 * Server-Regel, der maskierten ID - nicht nach dem Namen: ein Besuch mit
 * sichtbarer ID ohne Namensfeld oder mit leerem Namen gehoert dem Betrachter. */
function receiptHiddenFromViewer(visit) {
  return Boolean(visit.has_receipt) && visit.receipt_document_id == null;
}

/* `onRefresh` rendert die Ansicht neu, aus der der Bericht geoeffnet wurde (Uebersicht,
 * Personal, Deep-Link). Ohne ihn ist es der Berichte-Tab in `content`. */
function openVisitReportModal(visit, content = null, { onRefresh = null } = {}) {
  const paid = !!visit.paid_at;
  // Die Ruecknahme bietet nur an, wem der Server sie zugesteht
  // (`can_mark_unpaid`, #1136) - die Admin-Regel wird hier nicht nachgebaut.
  // Bei `housekeeping: read` liest der Bericht nur: weder Bezahlen noch
  // Zuruecknehmen, auch wenn die Felder aus einer aelteren Antwort stammen.
  const writable = !readOnly();
  let footerAction = '';
  if (writable && visit.can_mark_paid) {
    footerAction = `
          <button class="btn btn--primary" type="button" id="visit-report-pay">
            <i data-lucide="check" class="icon-sm" aria-hidden="true"></i>${esc(t('housekeeping.markPaid'))}
          </button>`;
  } else if (writable && visit.can_mark_unpaid) {
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
          ${visitWorkDetailsHtml(visit)}
          <div><dt>${esc(t('housekeeping.extras'))}</dt><dd>${esc(money(visit.extras))}</dd></div>
          <div><dt>${esc(t('housekeeping.totalPayment'))}</dt><dd>${esc(money(visit.total_amount))}</dd></div>
          <div><dt>${esc(t('housekeeping.paymentStatus'))}</dt><dd>${esc(paid ? t('housekeeping.paymentPaid') : t('housekeeping.paymentPending'))}</dd></div>
          ${visit.payment_task_id ? `<div><dt>${esc(t('housekeeping.paymentTask'))}</dt><dd>#${esc(visit.payment_task_id)}</dd></div>` : ''}
          ${visit.calendar_event_id ? `<div><dt>${esc(t('housekeeping.calendarEvent'))}</dt><dd>#${esc(visit.calendar_event_id)}</dd></div>` : ''}
          ${visitReceiptDetailHtml(visit)}
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
        if (onRefresh) await onRefresh();
        else if (content?.isConnected) renderReports(content);
        refocusAfterRender();
      }));
      panel.querySelector('#visit-report-unpay')?.addEventListener('click', () => unpayVisit(visit, async () => {
        closeModal({ force: true });
        await loadData();
        if (onRefresh) await onRefresh();
        else if (content?.isConnected) renderReports(content);
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
      ${readOnly() ? `
      <button class="btn btn--secondary btn--icon" type="button" data-open-worker="${item.id}"
              aria-label="${esc(t('housekeeping.openWorkerProfile'))}: ${esc(item.display_name)}">
        <i data-lucide="id-card" aria-hidden="true"></i>
      </button>` : `
      <button class="btn btn--secondary btn--icon" type="button" data-edit-worker="${item.id}" aria-label="${esc(t('common.edit'))}">
        <i data-lucide="edit-2" aria-hidden="true"></i>
      </button>`}
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
      if (event.target.closest('[data-edit-worker], [data-open-worker]')) return;
      select();
    });
  });
  // Bei `read` fuehrt das Profil in die Leseansicht (wie der Bericht-Knopf
  // an einer Besuchszeile) - Kontaktdaten, Geburtstag, Tarif und Notizen
  // stuenden sonst nur im Bearbeiten-Dialog, und der geht bei `read` nicht auf.
  content.querySelectorAll('[data-open-worker]').forEach((btn) => {
    btn.addEventListener('click', (event) => {
      event.stopPropagation();
      const worker = state.workers.find((item) => String(item.id) === btn.dataset.openWorker);
      if (worker) openStaffReadModal(worker);
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
  content.querySelectorAll('[data-open-visit]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const visit = state.staffVisits.find((item) => String(item.id) === btn.dataset.openVisit);
      if (visit) openVisitReportModal(visit, null, {
        onRefresh: async () => {
          await loadStaffVisits();
          if (content.isConnected) renderStaff(content);
        },
      });
    });
  });
  // Alles darunter schreibt. Die lesenden Wege - Person waehlen, Monat, Bericht -
  // stehen deshalb davor und haengen auch bei `read`.
  if (!readOnly()) wireStaffWrites(content);
  if (window.lucide) window.lucide.createIcons({ el: content });
}

function wireStaffWrites(content) {
  content.querySelectorAll('[data-edit-worker]').forEach((btn) => {
    btn.addEventListener('click', (event) => {
      event.stopPropagation();
      const worker = state.workers.find((item) => String(item.id) === btn.dataset.editWorker) || null;
      openStaffModal(worker, content);
    });
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
}

/* Der Bezahl-Knopf des Personal-Protokolls. Er traegt keinen Zustand, den die
 * Zeile nicht schon nennt: der Zahlstatus steht in der Metazeile
 * (`visitPaymentMeta()`), siehe renderStaffVisitLog().
 *
 * DIE ANTWORT FOLGT DEM DATENSATZ UND DEM RECHT (#1265 P6). Bei
 * `housekeeping: read` faellt der Knopf ganz weg. Vorher stand er dort als
 * `disabled` mit der Beschriftung „Als bezahlt markieren" - ein Versprechen fuer
 * eine Beruehrung, die nichts tut. Dasselbe gilt fuer einen UNBEZAHLTEN Besuch,
 * dessen Bezahlen der Server nicht anbietet (`can_mark_paid`): das ist genau die
 * Lage bei `read`, so wie der Server sie meldet. Uebrig bleibt der gesperrte
 * Knopf am bezahlten Besuch mit Schreibrecht - er stand schon vor #1265 so da
 * und ist nicht Teil dieser Regel. */
function staffLogPayHtml(visit, visitDate) {
  const paid = !!visit.paid_at;
  if (readOnly() || (!paid && !visit.can_mark_paid)) return '';
  return `<button class="row-action" type="button" data-pay-visit="${visit.id}" ${visit.can_mark_paid ? '' : 'disabled'}
                  aria-label="${esc(paid ? t('housekeeping.paymentPaid') : t('housekeeping.markPaid'))}: ${esc(visitDate)}">
            <i data-lucide="badge-dollar-sign" class="icon-md" aria-hidden="true"></i>
          </button>`;
}

function renderStaffVisitLog() {
  const worker = state.workers.find((item) => String(item.id) === String(state.selectedStaffId));
  if (!worker) return '';
  const rows = state.staffVisits.map((visit) => {
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
          <div class="list-row__meta">${esc(money(visit.total_amount))} · ${esc(visitPaymentMeta(visit))}</div>
        </div>
        <div class="list-row__actions">
          ${staffLogPayHtml(visit, visitDate)}
          ${visitEditActionHtml(visit, visitDate)}
          ${visitDeleteActionHtml(visit, visitDate)}
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
  if (readOnly()) return;
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
        // Der Dialog kann vor einem Rechtewechsel aufgegangen sein: dann
        // unterbleibt der Schreibvorgang, statt am 403 zu enden.
        if (readOnly()) return;
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

/**
 * Der Beleg im Einsatz-Dialog. Er schreibt in ein FREMDES Modul (#1265).
 *
 * Hochladen ist `POST /documents`, und der Server misst das als `documents`,
 * nicht als `housekeeping`. Wer die Haushaltshilfe pflegen, Dokumente aber nur
 * lesen darf, sah die Ablage, und das Speichern endete am 403 - vor dem
 * Einsatz selbst, der danach ungespeichert blieb. `applyModuleReadonly()` sieht
 * das nicht, es urteilt ueber das offene Nav-Modul. Gefragt wird deshalb AM
 * Bedienelement, mit dem Pfad, den die Handlung schreibt (Regel 1 in
 * utils/module-access.js), und in den drei Stufen des Anhangsfelds
 * (components/document-attach.js):
 *   - `write`: die Ablage wie bisher;
 *   - `read`: keine Ablage. Ein schon verknuepfter Beleg bleibt als Angabe
 *     stehen - gesetzt heisst sichtbar -, ohne Beleg faellt die Stelle weg;
 *   - `none`: nichts, dort antwortet schon das Lesen mit 403.
 * Die Verknuepfung selbst (`receipt_document_id`) speichert der Einsatz ueber
 * seinen eigenen Pfad, sie bleibt unangetastet.
 */
function receiptFieldHtml(visit) {
  if (pathAccess('/documents') !== 'none' && receiptHiddenFromViewer(visit)) {
    return `
        <dl class="housekeeping-report-details">
          <div><dt>${esc(t('housekeeping.receiptLabel'))}</dt><dd>${esc(t('documentAttach.lockedPrivate'))}</dd></div>
        </dl>`;
  }
  if (mayWritePath('/documents')) {
    return `
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
        </label>`;
  }
  if (pathAccess('/documents') === 'none' || !visit.receipt_document_name) return '';
  return `
        <dl class="housekeeping-report-details">
          <div><dt>${esc(t('housekeeping.receiptLabel'))}</dt><dd>${esc(visit.receipt_document_name)}</dd></div>
        </dl>`;
}

function openVisitEditModal(visit, content, { onDone } = {}) {
  // Der Riegel steht VOR jeder Vorbereitung, und ein bestehender Besuch geht
  // bei `read` als Leseansicht auf: der Einsatzbericht zeigt alles, was der
  // Dialog zeigt (Muster: `openNoteModal()` in notes.js, #1265 P1).
  if (readOnly()) {
    openVisitReportModal(visit);
    return;
  }
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
        ${receiptFieldHtml(visit)}
        <button class="btn btn--primary housekeeping-form-submit" type="submit">
          <i data-lucide="save" aria-hidden="true"></i>
          <span>${esc(t('common.save'))}</span>
        </button>
      </form>
    `,
    onSave: (panel) => {
      panel.querySelector('#housekeeping-visit-form')?.addEventListener('submit', async (event) => {
        event.preventDefault();
        if (readOnly()) return;
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
          // Der zweite Riegel fuer den Beleg: ohne Schreibrecht auf die
          // Dokumente wird nichts hochgeladen, auch wenn ein Feld aus einem
          // aelteren Stand noch eine Datei traegt. Der Einsatz speichert dann
          // mit der Verknuepfung, die er schon hat. Ebenso bei einem Beleg,
          // den der Server nicht nennt (#1358): ihn ersetzen weist der Server
          // mit 403 ab, das hochgeladene Dokument bliebe verwaist liegen.
          const file = mayWritePath('/documents') && !receiptHiddenFromViewer(visit)
            ? panel.querySelector('#housekeeping-receipt-file')?.files?.[0]
            : null;
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

/**
 * Das Profil einer Person bei `housekeeping: read`: Leseansicht, sonst nichts
 * (#1265 P6, Muster: `openNoteReadModal()` in notes.js, #1265 P1).
 *
 * Warum ein eigener Dialog und nicht der Bearbeiten-Dialog mit gesperrten
 * Feldern: jedes Stueck davon SCHREIBT - das Bild waehlt eine Datei, jedes Feld
 * ist eine Eingabe, die Fusszeile speichert. Uebrig bleiben die Werte, und genau
 * die zeigt dieser Dialog: alles, was der Bearbeiten-Dialog zeigt, und nichts,
 * was er nicht zeigt. Der Tarif erscheint wie dort nur mit dem Satz, der zur
 * Abrechnungsart gehoert.
 *
 * Die Antwort folgt dem DATENSATZ: ein leeres Feld (kein Benutzername, keine
 * E-Mail, keine Notiz) bekommt keine Zeile - ein Strich waere ein Wert, den es
 * nicht gibt. Die beiden Farben stehen als Farbfeld MIT ihrem Wert, damit die
 * Auskunft nicht allein an der Farbe haengt.
 */
function openStaffReadModal(worker) {
  const hourly = worker.rate_type === 'hourly';
  const row = (labelKey, valueHtml) => `
          <div><dt>${esc(t(labelKey))}</dt><dd>${valueHtml}</dd></div>`;
  const swatch = (color) => `<span class="housekeeping-swatch" style="--swatch:${esc(color)}" aria-hidden="true"></span>${esc(color)}`;
  openModal({
    title: t('housekeeping.profileTitle'),
    size: 'md',
    content: `
      <div class="housekeeping-report-modal" data-view="read">
        <div class="housekeeping-staff-row">
          <div class="housekeeping-avatar" style="background:${esc(worker.avatar_color) || 'var(--module-housekeeping)'}">
            ${worker.avatar_data ? `<img src="${esc(worker.avatar_data)}" alt="${esc(worker.display_name)}">` : esc(initials(worker.display_name))}
          </div>
          <div>
            <strong>${esc(worker.display_name)}</strong>
          </div>
        </div>
        <dl class="housekeeping-report-details">
          ${worker.username ? row('housekeeping.workerUsername', esc(worker.username)) : ''}
          ${worker.phone ? row('housekeeping.workerPhone', esc(worker.phone)) : ''}
          ${worker.email ? row('housekeeping.workerEmail', esc(worker.email)) : ''}
          ${worker.birth_date ? row('housekeeping.workerBirthDate', esc(formatDate(worker.birth_date))) : ''}
          ${row('housekeeping.rateType', esc(t(hourly ? 'housekeeping.rateHourly' : 'housekeeping.rateDaily')))}
          ${hourly
    ? row('housekeeping.hourlyRate', esc(money(worker.hourly_rate)))
    : row('housekeeping.dailyRate', esc(money(worker.daily_rate)))}
          ${row('housekeeping.paymentSchedule', esc(scheduleLabel(worker.payment_schedule)))}
          ${worker.calendar_color ? row('housekeeping.calendarColor', swatch(worker.calendar_color)) : ''}
          ${worker.avatar_color ? row('housekeeping.profileColor', swatch(worker.avatar_color)) : ''}
          ${worker.notes ? `
          <div class="housekeeping-report-details__block"><dt>${esc(t('housekeeping.workerNotes'))}</dt><dd>${esc(worker.notes)}</dd></div>` : ''}
        </dl>
      </div>
    `,
  });
}

function openStaffModal(worker, content, options = {}) {
  // Der Riegel steht VOR jeder Vorbereitung: der Anlegeweg entfaellt ganz, eine
  // bestehende Person geht als Leseansicht auf (wie `openNoteModal()`).
  if (readOnly()) {
    if (worker) openStaffReadModal(worker);
    return;
  }
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
          <input class="sr-only" type="file" id="housekeeping-avatar-file" accept="image/png,image/jpeg,image/webp"
                 aria-label="${esc(t('housekeeping.profilePicture'))}" tabindex="-1">
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
        if (readOnly()) return;
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
          // Eine neue Kraft kann ein Modul mitlesen: `othersCanRead` neu holen.
          await auth.me().catch(() => {});
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

// `?editVisit=<id>` (die beiden Kalender-Termin-Klicks in `calendar.js` -
// `openEventDetail`/`openEventModal` - bauen diesen Link; keine Erinnerung
// oder Benachrichtigung tut das): der Fehlerfall war zuvor ein leerer `catch`
// - eine falsche, geloeschte oder fremde ID landete unauffaellig auf dem
// normalen Dashboard, nicht unterscheidbar von einem funktionierenden Link
// (#1139). Die fehlgeschlagene Kennung wird sofort aus der URL entfernt (nur
// sie: uebrige Parameter, Hash und `history.state` bleiben stehen, wie in
// `sync-calendar.js`/`documents-storage.js`), damit ein erneutes Rendern
// (Zurueck-Navigation, Reload) den Aufruf nicht wiederholt; ein erneuter
// Versuch ueber den Retry-Toast haelt die ID dafuer in diesem Closure fest.
// Jeder 4xx-Status ausser 429 (404 fehlt, 403 kein Zugriff, 400 z.B. eine
// verstuemmelte ID) ist ein Endzustand fuer dieselbe ID - ein Retry liefert
// nur denselben Fehler noch einmal. 429 dagegen ist voruebergehend: der
// `apiLimiter` erlaubt 300 Anfragen/Minute PRO IP, ein Haushalt hinter einem
// NAT teilt sich diese IP, und `api.js` traegt sogar `Retry-After` am
// `ApiError` - ein Retry kann hier durchaus gelingen. Neben 429 duerfen es
// also ein Serverfehler und ein Netzwerkproblem (kein Status) erneut
// versuchen. `friendlyError()` kennt nur 403/404/5xx explizit und faellt
// sonst auf den rohen, unlokalisierten Servertext zurueck (`err.data.error`)
// - fuer jeden anderen 4xx (auch 429) wird deshalb bewusst die generische,
// lokalisierte Meldung erzwungen statt dieser Fallback-String. Es gilt keine
// visit-eigene Zugriffssperre - `GET /visits/:id` prueft nur die ID, der
// einzige 403 kommt vom Modul-Gate, und der Router leitet vor dieser Stelle
// schon weg (siehe render()) - 403 wird trotzdem defensiv behandelt, etwa fuer
// ein Wettrennen zwischen Seitenaufbau und Rechteentzug.
function describeDeepLinkError(err) {
  const status = err?.status;
  const isTransient = status == null || status >= 500 || status === 429;
  const message = (status >= 400 && status < 500 && status !== 403 && status !== 404)
    ? t('common.errorGeneric')
    : (window.yuvomi?.friendlyError?.(err) ?? t('common.errorGeneric'));
  return { message, offerRetry: isTransient };
}

async function openVisitFromDeepLink(editVisitId, container, signal) {
  try {
    const res = await api.get(`/housekeeping/visits/${editVisitId}`);
    // Der Router bricht das Signal beim Seitenwechsel ab (`router.js`): kommt
    // die Antwort erst danach an, gehoert der Bildschirm laengst einer anderen
    // Seite - kein Modal mehr oeffnen.
    if (signal?.aborted) return;
    const visit = res.data;
    if (visit) {
      const content = container.querySelector('#housekeeping-content') || container;
      // Wer einen abgerechneten Besuch nicht aendern darf, bekommt den
      // Bericht statt eines Formulars, das erst beim Speichern scheitert (#1135) -
      // ebenso, wer die Haushaltshilfe nur lesen darf (#1265 P6).
      if (visit.can_edit && !readOnly()) openVisitEditModal(visit, content);
      else openVisitReportModal(visit, null, { onRefresh: () => renderCurrentTab(container) });
    }
  } catch (err) {
    // Nach einem Seitenwechsel zeigt `location` schon die NEUE Seite: das
    // `replaceState` traefe deren URL (und wuerde ihre Parameter und den
    // Router-State verwerfen), der Toast erschiene ueber der falschen Seite.
    if (signal?.aborted) return;
    const url = new URL(location.href);
    url.searchParams.delete('editVisit');
    history.replaceState(history.state, '', url.pathname + url.search + url.hash);
    const { message, offerRetry } = describeDeepLinkError(err);
    if (offerRetry) {
      window.yuvomi?.showToast(message, 'danger', 6000, {
        label: t('common.retry'),
        onClick: () => {
          // Der Toast lebt bis zu 6 s weiter - auch ueber einen Seitenwechsel
          // hinaus. Ein Klick darf dann das Bearbeiten-Modal nicht ueber einer
          // fremden Seite oeffnen.
          if (signal?.aborted) return;
          openVisitFromDeepLink(editVisitId, container, signal);
        },
      });
    } else {
      window.yuvomi?.showToast(message, 'danger');
    }
  }
}

export async function render(container, { signal } = {}) {
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
    if (editVisitId) await openVisitFromDeepLink(editVisitId, container, signal);
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
      onRetry: () => render(container, { signal }),
    });
  }
}

// Nur fuer die Tests (test-housekeeping-ui.js, test-housekeeping-editvisit.js):
// die Seite laeuft dort ohne DOM.
export const __test = {
  describeDeepLinkError,
  openVisitFromDeepLink,
  loadData,
  renderReports,
  renderStaffVisitLog,
  showReportMonth,
  stepReportMonth,
  shiftMonth,
  visitEditActionHtml,
  visitDeleteActionHtml,
  visitPaymentMeta,
  // #1265 P6 (test-module-readonly-ui.js): die Nur-lesen-Regel am erzeugten
  // Markup, an den Einstiegen und am Riegel.
  readOnly,
  readOnlyLatch,
  READ_SAFE_CONTROLS,
  renderShell,
  renderDashboard,
  renderWorkerSummary,
  renderTasks,
  openTaskCreateModal,
  completeTask,
  reportMonthNavHtml,
  syncReportPeriod,
  renderStaff,
  staffLogPayHtml,
  receiptFieldHtml,
  openVisitEditModal,
  openVisitReportModal,
  openTaskEditModal,
  openStaffModal,
  openStaffReadModal,
  toggleSession,
  createTask,
  payVisit,
  unpayVisit,
  state: () => state,
};
