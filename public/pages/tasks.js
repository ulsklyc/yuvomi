/**
 * Modul: Aufgaben (Tasks)
 * Zweck: Listenansicht mit Filtern, Gruppierung, CRUD-Modal, Subtask-Verwaltung
 * Abhängigkeiten: /api.js
 */

import { api } from '/api.js';
import { renderRRuleFields, bindRRuleEvents, getRRuleValues } from '/rrule-ui.js';
import { openModal as openSharedModal, closeModal, wireBlurValidation, validateAll, btnSuccess, btnError, btnLoading, promptModal, confirmModal, advancedSection, refocusAfterRender } from '/components/modal.js';
import { stagger, vibrate, scheduleUndoableDelete, animationSettled } from '/utils/ux.js';
import { wireSwipeRows, maybeShowSwipeHint } from '/utils/swipe-row.js';
import { t, getLocale, formatDate, formatTime, formatDateInput, parseDateInput, isDateInputValid, formatTimeInput, parseTimeInput } from '/i18n.js';
import { esc } from '/utils/html.js';
import { renderMarkdownToolbar, wireMarkdownToolbar } from '/utils/markdown-toolbar.js';
import { refresh as refreshReminders } from '/reminders.js';
import { renderUserMultiSelect, getSelectedUserIds, bindUserMultiSelect, renderAvatarStack } from '/components/user-multi-select.js';
import { resolveReminderPreset } from '/utils/reminder-offset.js';
import { renderPageSearch, wirePageSearch } from '/utils/page-search.js';
import { renderDocumentAttachField, bindDocumentAttachField } from '/components/document-attach.js';
import { emptyStateHTML, mountLoadError } from '/utils/empty-state.js';
import '/components/category-manager.js';
import '/components/tag-manager.js';
import { findPageFab } from '/utils/fab.js';
import { isSoloHousehold } from '/utils/household.js';
import { todayKey, parseLocalDateKey } from '/utils/date.js';
import { makeSortable } from '/utils/sortable.js';
import { zonedDateKey } from '/utils/timezone.js';
import { historyDayLabel } from '/utils/day-label.js';
import {
  PRIORITIES, PRIO_ORDER, STATUSES, FILTER_STATUSES, PRIORITY_LABELS, STATUS_LABELS,
  FALLBACK_CATEGORY, isArchived, formatDueDate, normalizeTagList,
  catLabel as catLabelOf, catSortIndex as catSortIndexOf,
  canEditTaskDefinition as canEditTaskDefinitionFor,
} from '/utils/task-fields.js';
import {
  openTaskDetail, deleteTaskWithUndo, addSubtask,
  setTaskArchived, toggleSubtaskStatus,
} from '/components/task-detail.js';

// --------------------------------------------------------
// Die geteilten Regeln, mit dem Blickwinkel DIESER Seite
//
// Was ein Feld bedeutet, steht seit #918 in utils/task-fields.js, damit die
// Leseansicht dieselbe Antwort gibt, egal wer sie oeffnet. Zwei dieser Regeln
// brauchen Kontext, den nur eine Ansicht hat: wer gerade schaut und welche
// Kategorien der Haushalt fuehrt. Die Wrapper hier setzen ihn ein, damit die
// Aufrufe in dieser Datei so kurz bleiben wie zuvor.
// --------------------------------------------------------

/** Wer schaut - fuer die Sperrregel aus #830. */
function viewer() {
  return { isAdmin: state.isAdmin, currentUserId: state.currentUserId };
}

function canEditTaskDefinition(task, parent = null) {
  return canEditTaskDefinitionFor(task, parent, viewer());
}

function catLabel(key, categories = state.categories) {
  return catLabelOf(key, categories);
}

function catSortIndex(key, categories = state.categories) {
  return catSortIndexOf(key, categories);
}

// --------------------------------------------------------
// Verknüpfte Dokumente (#503, #733)
//
// Das Feld ist seit #733 die geteilte Komponente aus components/document-attach.js
// - dieselbe, die Budget, Gemeinsame Ausgaben und Inventar benutzen. Vorher
// führten die Aufgaben als einziges Modul eine eigene Auswahlliste, und die
// konnte nur verknüpfen, was schon abgelegt war: eine Datei AN der Aufgabe
// hochzuladen ging nirgends, obwohl der Baustein dafür seit #583 im Haus liegt.
//
// `taskDocuments` ist der Controller des offenen Formulars. commit() lädt
// wartende Dateien hoch und liefert die vollständige ID-Liste, die
// handleFormSubmit als Replace-Set an PUT /tasks/:id/documents gibt.
let taskDocuments = null;

// --------------------------------------------------------
// Hilfsfunktionen
// --------------------------------------------------------

function initials(name = '') {
  return name.split(' ').map((w) => w[0]).join('').slice(0, 2).toUpperCase();
}

// Sichtbarkeits-Indikator (#474): nur für eingeschränkte Elemente ein dezentes
// Icon — „Alle" bleibt icon-los (keine visuelle Flut, „Kraft ohne Lärm").
function renderVisibilityBadge(visibility) {
  if (!visibility || visibility === 'all') return '';
  const icon  = visibility === 'private' ? 'lock' : 'users';
  const label = visibility === 'private'
    ? t('common.visibility.private')
    : t('common.visibility.assignees');
  return `<span class="due-date task-card__visibility" title="${esc(label)}" aria-label="${esc(label)}">
            <i data-lucide="${icon}" class="icon-sm" aria-hidden="true"></i>
          </span>`;
}

/**
 * Gruppiert die Aufgaben und gibt je Gruppe `{ id, label, tasks }`.
 *
 * Die `id` ist bewusst NICHT das angezeigte Label: eingeklappte Gruppen werden
 * gespeichert (#812), und ein uebersetzter Name als Schluessel haette den
 * Zustand bei jedem Sprachwechsel verloren - „Heute" und „Today" waeren zwei
 * verschiedene Gruppen. Die Kategorie bringt ihren stabilen Schluessel schon
 * mit, die Faelligkeits-Gruppen bekommen hier feste Namen.
 */
/** Schluessel einer Gruppe im Speicher: Modus und Id zusammen. */
function groupKey(mode, id) {
  return `${mode}:${id}`;
}

function isGroupCollapsed(mode, id) {
  return state.collapsedGroups.has(groupKey(mode, id));
}

/**
 * Klappt eine Gruppe um und merkt sich das (#812).
 *
 * Gespeichert wird nur, was EINGEKLAPPT ist: eine neue Gruppe - eine frisch
 * angelegte Kategorie, „Ueberfaellig" beim ersten ueberfaelligen Eintrag -
 * erscheint damit offen. Die Umkehrung haette sie versteckt, obwohl niemand sie
 * je zugeklappt hat.
 */
function toggleGroup(mode, id) {
  const key = groupKey(mode, id);
  if (state.collapsedGroups.has(key)) state.collapsedGroups.delete(key);
  else state.collapsedGroups.add(key);
  try {
    localStorage.setItem(COLLAPSED_GROUPS_KEY, JSON.stringify([...state.collapsedGroups]));
  } catch { /* Privatmodus/Quota: der Zustand gilt dann nur fuer diese Sitzung */ }
}

function loadCollapsedGroups() {
  try {
    const raw = JSON.parse(localStorage.getItem(COLLAPSED_GROUPS_KEY) ?? '[]');
    state.collapsedGroups = new Set(Array.isArray(raw) ? raw.filter((k) => typeof k === 'string') : []);
  } catch {
    state.collapsedGroups = new Set();
  }
}

function groupBy(tasks, mode, categories = state.categories) {
  const groups = {};

  if (mode === 'category') {
    for (const t of tasks) {
      const key = t.category || FALLBACK_CATEGORY;
      (groups[key] = groups[key] || []).push(t);
    }
    return Object.entries(groups)
      // Unbekannte Keys landen alle auf demselben Index - erst dahinter darf
      // das Alphabet entscheiden, und dann über das Label in der aktiven
      // Sprache statt über den Schlüssel.
      .sort(([a], [b]) => catSortIndex(a, categories) - catSortIndex(b, categories)
        || catLabel(a, categories).localeCompare(catLabel(b, categories), getLocale()))
      .map(([key, list]) => ({ id: key, label: catLabel(key, categories), tasks: list }));
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
      // Beide Seiten als KALENDERTAG rechnen, nicht als Instant.
      //
      // `new Date('2026-08-24')` ist UTC-Mitternacht, `setHours(0,0,0,0)` die
      // lokale - die Differenz trug damit den Zonen-Offset mit. Ab +12 Stunden
      // rundete sie auf einen ganzen Tag auf, und eine heute faellige Aufgabe
      // stand in Neuseeland unter „Diese Woche" statt unter „Heute" (in
      // Kiritimati ebenso). Der Kalendertag kommt jetzt aus `todayKey()` und
      // folgt damit derselben Zone wie der Rest der App (#829).
      const diff = Math.round(
        (parseLocalDateKey(task.due_date) - parseLocalDateKey(todayKey())) / 86400000,
      );
      if (diff < 0)       key = groupOverdue;
      else if (diff === 0) key = groupToday;
      else if (diff <= 3)  key = groupThisWeek;
      else if (diff <= 7)  key = groupNextWeek;
      else                 key = groupLater;
    }
    (groups[key] = groups[key] || []).push(task);
  }

  const order = [
    ['overdue',  groupOverdue],
    ['today',    groupToday],
    ['thisWeek', groupThisWeek],
    ['nextWeek', groupNextWeek],
    ['later',    groupLater],
    ['noDate',   groupNoDate],
  ];
  return order
    .filter(([, label]) => groups[label])
    .map(([id, label]) => ({ id, label, tasks: groups[label] }));
}

// --------------------------------------------------------
// Render-Bausteine
// --------------------------------------------------------

// Die Stufe steht am PUNKT, nicht am Etikett: seit die Fuellung entfallen ist
// (Skalen-Regel, DESIGN.md) traegt `.priority-badge` keine Farbe mehr, und eine
// Modifier-Klasse ohne Regel ist tote Auszeichnung.
function renderPriorityBadge(priority) {
  if (priority === 'none') return '';
  return `<span class="priority-badge">
    <span class="priority-dot priority-dot--${priority}"></span>
    ${PRIORITY_LABELS()[priority] ?? priority}
  </span>`;
}

function renderDueDate(dateStr, timeStr, isDone = false) {
  const d = formatDueDate(dateStr, timeStr, isDone);
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
      <div class="swipe-reveal swipe-reveal--done swipe-reveal--leading" aria-hidden="true">
        <i data-lucide="${isDone ? 'rotate-ccw' : 'check'}" class="icon-xl" aria-hidden="true"></i>
        <span>${isDone ? t('tasks.swipeOpen') : t('tasks.swipeDone')}</span>
      </div>
      <div class="swipe-reveal swipe-reveal--edit swipe-reveal--trailing" aria-hidden="true">
        <i data-lucide="eye" class="icon-xl" aria-hidden="true"></i>
        <span>${t('tasks.swipeView')}</span>
      </div>
      ${innerHtml}
    </div>`;
}

// --------------------------------------------------------
// Sync-Ziel einer neuen Aufgabe (#695)
// --------------------------------------------------------

/**
 * Das Ziel-Feld des Aufgaben-Dialogs.
 *
 * Es fehlt in zwei Faellen, und beide sind Aussagen ueber die Aufgabe, nicht
 * ueber die Oberflaeche:
 *
 * - Unteraufgaben tragen kein eigenes Ziel. Sie gehoeren zu ihrer Elternaufgabe,
 *   und als eigenstaendiges VTODO stuenden sie auf dem Server gleichrangig
 *   daneben.
 * - Eine bereits hochgeladene Aufgabe kann ihre Liste nicht mehr wechseln: einen
 *   Umzug zwischen Listen gibt es bewusst nicht. Statt eines toten Dropdowns
 *   steht dort ein Satz, der sagt, dass sie abgeglichen wird - sonst sieht die
 *   Maske aus, als haette man die Wahl vergessen.
 */
function syncTargetFieldHtml(task) {
  if (task?.parent_task_id) return '';

  if (task?.external_source === 'caldav') {
    return `
      <div class="form-group">
        <span class="label">${t('tasks.syncTargetLabel')}</span>
        <p class="form-hint">${t('tasks.syncTargetMirrored')}</p>
      </div>
`;
  }

  return `
      <div class="form-group">
        <label class="label" for="task-sync-target">${t('tasks.syncTargetLabel')}</label>
        <select class="input" id="task-sync-target" name="sync_target">
          <option value="">${t('tasks.syncTargetLocal')}</option>
        </select>
        <small class="form-hint">${t('tasks.syncTargetHint')}</small>
      </div>
`;
}

/**
 * Fuellt das Ziel-Feld aus /tasks/sync-targets.
 *
 * Faellt der Aufruf aus, bleibt die einzige Option "nur lokal" stehen - das ist
 * derselbe Zustand wie ohne eingerichtete Erinnerungsliste und verliert nichts:
 * ein nicht gesetztes Ziel laesst die Aufgabe lokal, so wie bisher jede.
 *
 * Ein gespeichertes, aber nicht mehr angebotenes Ziel wird nachgetragen, damit
 * die Maske nicht "nur lokal" behauptet, waehrend die Aufgabe auf eine Liste
 * wartet. Der persoenliche Standard dagegen wird NICHT nachgetragen: er soll
 * eine neue Aufgabe nicht auf eine Liste richten, die es nicht mehr gibt.
 */
async function wireSyncTarget(panel, task) {
  const select = panel.querySelector('#task-sync-target');
  if (!select) return;

  let lists = [];
  try {
    const res = await api.get('/tasks/sync-targets');
    lists = res.data?.caldav ?? [];
  } catch (err) {
    console.warn('[Tasks] Sync-Ziele nicht ladbar:', err.message);
  }

  const current = task?.target_caldav_account_id && task?.target_caldav_list_url
    ? `caldav:${task.target_caldav_account_id}|${task.target_caldav_list_url}`
    : '';

  const byAccount = new Map();
  for (const list of lists) {
    if (!byAccount.has(list.accountName)) byAccount.set(list.accountName, []);
    byAccount.get(list.accountName).push(list);
  }

  for (const [accountName, group] of byAccount) {
    const optgroup = document.createElement('optgroup');
    optgroup.label = accountName;
    for (const list of group) {
      const option = document.createElement('option');
      option.value = `caldav:${list.accountId}|${list.listUrl}`;
      option.textContent = list.listName || list.listUrl;
      optgroup.appendChild(option);
    }
    select.appendChild(optgroup);
  }

  if (current && !Array.from(select.options).some((o) => o.value === current)) {
    const option = document.createElement('option');
    option.value = current;
    option.textContent = t('tasks.syncTargetUnavailable');
    select.appendChild(option);
  }

  const wanted = current || (task ? '' : state.defaultSyncTarget);
  if (wanted && Array.from(select.options).some((o) => o.value === wanted)) {
    select.value = wanted;
  }
}

/**
 * EINE Metazeile, und sie bricht nicht um.
 *
 * Die Zeile trug bis zu acht Elemente mit `flex-wrap: wrap` und wurde damit je
 * nach Aufgabe zwei- bis dreizeilig - der eigentliche Höhentreiber der Liste,
 * nicht die Polsterung. Drei Regeln nehmen das zurück, ohne Information zu
 * verstecken, die es nur hier gibt:
 *
 * 1. ZWEI DATEN SIND EINS ZU VIEL. Das Startdatum erscheint nur, wenn es keine
 *    Fälligkeit gibt. Steht beides an, ist die Fälligkeit die Frage, die die
 *    Liste beantwortet; der Beginn steht in der Detailfläche.
 * 2. DIE KATEGORIE STEHT NICHT ZWEIMAL. Beim Gruppieren nach Kategorie ist der
 *    Gruppenkopf darüber schon die Antwort - das Etikett wiederholte ihn in
 *    jeder Zeile der Gruppe.
 * 3. EIN TAG STATT DREI, der Rest als „+N". Der Marker existiert bereits
 *    (.task-tag--more) und sagt, dass etwas fehlt - das tut ein Abschnitt nicht.
 *
 * Anhänge werden zur reinen Glyphe: die Zahl daneben war die einzige Stelle der
 * Zeile, an der eine Anzahl OHNE ihren Gegenstand stand.
 */
function renderTaskCard(task, opts = {}) {
  const { expandedSubtasks = false, showCheckbox = false, isChecked = false, showCategory = true } = opts;
  const isDone = task.status === 'done';
  const archived = isArchived(task);
  // Gesperrte Aufgabe (#830): abhaken bleibt, umschreiben nicht. Die Knoepfe,
  // die in einem 403 endeten, stehen deshalb gar nicht erst da.
  const canEdit = canEditTaskDefinition(task);
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
          ${canEditTaskDefinition(s, task) ? `
          <div class="subtask-item__actions">
            <button class="btn btn--ghost btn--icon btn--icon-sm subtask-item__action"
                    data-action="rename-subtask" data-id="${s.id}" data-title="${esc(s.title)}"
                    aria-label="${t('tasks.subtaskRename', { title: esc(s.title) })}">
              <i data-lucide="pencil" aria-hidden="true"></i>
            </button>
            <button class="btn btn--ghost btn--icon btn--icon-sm subtask-item__action"
                    data-action="delete-subtask" data-id="${s.id}" data-title="${esc(s.title)}"
                    aria-label="${t('tasks.subtaskDelete', { title: esc(s.title) })}">
              <i data-lucide="trash-2" aria-hidden="true"></i>
            </button>
          </div>` : ''}
        </div>`).join('')
    : '';

  return `
    <div class="task-card ${isDone ? 'task-card--done' : ''} ${archived ? 'task-card--archived' : ''}" data-task-id="${task.id}">
      <div class="list-row list-row--roomy task-card__main">
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
          <button type="button" class="task-card__title u-card-title u-compact" data-action="open-task" data-id="${task.id}">
            ${esc(task.title)}
          </button>
          <div class="task-card__meta">
            ${archived ? `<span class="due-date task-card__archived"><i data-lucide="archive" class="icon-sm" aria-hidden="true"></i>${t('tasks.statusArchived')}</span>` : ''}
            ${renderPriorityBadge(task.priority)}
            ${task.due_date ? '' : renderStartDateBadge(task.start_date)}
            ${renderDueDate(task.due_date, task.due_time, isDone || archived)}
            ${/* `role="img"`, sonst wertet keine Hilfstechnik das `aria-label` aus:
                an einem generischen <span> ohne Rolle ist es wirkungslos. Solange
                die Ziffer noch danebenstand, las der Screenreader wenigstens sie -
                seit der Dichte-Runde traegt das Label die Anzahl allein. Dieselbe
                Marke im Budget (budget.js, `.budget-recur-mark`) macht es richtig;
                hier standen zwei Kopien ohne Rolle (PR-Review #754). */ ''}
            ${task.is_recurring ? `<span class="due-date" role="img" aria-label="${esc(t('tasks.recurring'))}"><i data-lucide="repeat" class="icon-sm" aria-hidden="true"></i></span>` : ''}
            ${task.document_count > 0 ? `<span class="due-date task-card__docs" role="img" aria-label="${esc(t('tasks.documentsCount', { count: task.document_count }))}"><i data-lucide="paperclip" class="icon-sm" aria-hidden="true"></i></span>` : ''}
            ${task.locked ? `<span class="due-date" role="img" aria-label="${esc(t('tasks.lockedBadge'))}" title="${esc(t('tasks.lockedBadge'))}"><i data-lucide="lock" class="icon-sm" aria-hidden="true"></i></span>` : ''}
            ${renderVisibilityBadge(task.visibility)}
            ${showCategory && task.category !== FALLBACK_CATEGORY ? `<span class="due-date task-card__category">${esc(catLabel(task.category))}</span>` : ''}
            ${renderTagBadges(task.tags, ROW_TAG_BADGES_VISIBLE, task.priority)}
          </div>
        </div>

        ${renderAvatarStack(task.assigned_users ?? [], { size: 28 })}

        ${/* Bleibt auch mit vorhandenen Unteraufgaben: bis D#1017 verschwand der
              Einstieg nach der ersten, und der zweite Einstieg lag am Ende der
              eingeklappten Liste - gelesen als "nur eine Unteraufgabe je Aufgabe". */ ''}
        ${canEdit && !archived && !task.parent_task_id ? `
        <button class="btn btn--ghost btn--icon btn--icon-sm task-card__inline-action" data-action="add-subtask" data-parent="${task.id}"
                aria-label="${t('tasks.subtaskAdd')}" title="${t('tasks.subtaskAdd')}">
          <i data-lucide="list-plus" class="icon-md" aria-hidden="true"></i>
        </button>` : ''}
        ${canEdit ? `
        <button class="btn btn--ghost btn--icon btn--icon-sm task-card__inline-action" data-action="edit-task" data-id="${task.id}"
                aria-label="${t('tasks.editButton')}">
          <i data-lucide="pencil" class="icon-md" aria-hidden="true"></i>
        </button>
        <button class="btn btn--ghost btn--icon btn--icon-sm task-card__inline-action"
                data-action="${archived ? 'unarchive-task' : 'archive-task'}" data-id="${task.id}"
                aria-label="${archived ? t('tasks.unarchiveButton') : t('tasks.archiveButton')}"
                title="${archived ? t('tasks.unarchiveButton') : t('tasks.archiveButton')}">
          <i data-lucide="${archived ? 'archive-restore' : 'archive'}" class="icon-md" aria-hidden="true"></i>
        </button>` : ''}
      </div>

      ${progress !== null ? `
        <button type="button" class="subtask-progress" data-action="toggle-subtasks" data-id="${task.id}"
                aria-expanded="${expandedSubtasks ? 'true' : 'false'}" aria-controls="subtasks-${task.id}"
                aria-label="${t('tasks.subtaskToggle')}">
          <div class="subtask-progress__bar-wrap">
            <div class="subtask-progress__bar-fill" style="--progress-scale:${progress / 100}"></div>
          </div>
          <span class="subtask-progress__text">${task.subtask_done}/${task.subtask_total}</span>
        </button>` : ''}

      ${task.subtasks?.length ? `
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
    // Leere Suche ≠ leeres Modul: bei aktiver Suche wäre „Noch keine Aufgaben"
    // schlicht falsch und der Anlegen-CTA die falsche Antwort (Notizen-Muster).
    const isFiltered = state.searchQuery.trim().length > 0;
    // Der Suchbegriff geht ROH in den Renderer: der escapt selbst. Vorher stand
    // hier ein `esc()` vor der Uebergabe, weil das Ergebnis in ein
    // Template-Literal floss - ueber den Renderer waere daraus eine zweite
    // Maskierung geworden und „a&b" haette als „a&amp;b" auf dem Schirm gestanden.
    return isFiltered
      ? emptyStateHTML({
        variant: 'no-results',
        title: t('tasks.noResultsTitle'),
        description: t('tasks.noResultsDescription', { query: state.searchQuery }),
      })
      : emptyStateHTML({
        icon: 'circle-check-big',
        title: t('tasks.emptyTitle'),
        description: t('tasks.emptyDescription'),
        hint: t('emptyHint.tasks'),
        action: { label: t('tasks.emptyAction'), icon: 'plus', attrs: { id: 'empty-cta-tasks' } },
      });
  }

  const now = new Date();
  const groups = groupBy(tasks, groupMode);
  return groups.map(({ id, label, tasks: groupTasks }) => {
    const sorted = [...groupTasks].sort((a, b) => sortTasks(a, b, now));
    const collapsed = isGroupCollapsed(groupMode, id);
    return `
    <div class="task-group list-group">
      <!-- Gruppenkopf als echte Ueberschrift (Critique 2026-08-10): /tasks
           hatte genau EIN h-Element im ganzen Dokument, und wer per H-Taste
           navigiert, kam damit auf den Seitentitel und nicht weiter. Der
           Seitentitel ist h1, die Gruppe darunter also h2.

           Die FORM kommt seit der Zusammenfuehrung aus der geteilten
           Gruppen-Grammatik (styles/list-row.css), wie im Einkauf und im
           Vorrat: Label und Zaehlstand stehen NEBENEINANDER. Vorher trug der
           Kopf ein eigenes space-between und schob die Zahl an die rechte
           Traegerkante - auf 1280px stand sie damit 640px vom Gruppennamen
           entfernt und las sich als unverbundener Wert. Genau diesen Befund
           hatte der Einkauf am 2026-07-30 schon einmal. -->
      <h2 class="list-group__title">
        <!-- Der Kopf ist ein Knopf, keine anklickbare Ueberschrift (#812): nur
             so kennt ihn die Tastatur, und nur so kann aria-expanded den
             Zustand ueberhaupt melden. -->
        <button type="button" class="list-group__toggle" data-group-toggle="${esc(id)}"
                aria-expanded="${collapsed ? 'false' : 'true'}">
          <i data-lucide="chevron-down" aria-hidden="true"
             class="list-group__chevron${collapsed ? ' list-group__chevron--collapsed' : ''}"></i>
          <span>${esc(label)}</span>
        </button>
        <span class="list-group__count">${groupTasks.length}</span>
      </h2>
      ${collapsed ? '' : `<div class="list-rows">
        ${sorted.map((t) => renderSwipeRow(t, renderTaskCard(t, {
          showCheckbox: state.bulkSelectMode,
          isChecked: state.selectedTaskIds.has(t.id),
          expandedSubtasks: state.subtasksExpandedByDefault,
          showCategory: groupMode !== 'category',
        }))).join('')}
      </div>`}
    </div>`;
  }).join('');
}

// --------------------------------------------------------
// Task-Modal (Erstellen / Bearbeiten)
// --------------------------------------------------------

// --------------------------------------------------------
// Tags (#586)
// Freie Etiketten, gespiegelt aus VTODO CATEGORIES. Bewusst getrennt von der
// Kategorie: eine Aufgabe liegt in einer Schublade, trägt aber beliebig viele
// Etiketten.
// --------------------------------------------------------
// Working-Set des offenen Bearbeiten-Dialogs, analog zu den verknüpften
// Dokumenten. Wird beim Öffnen aus der Aufgabe gefüllt und beim Speichern gelesen.
let modalTags = [];
/** Zeichnet die Chips des Tag-Editors neu. */
function renderTagChips(container) {
  const wrap = container.querySelector('#task-tags-chips');
  if (!wrap) return;
  wrap.replaceChildren();

  modalTags.forEach((tag, index) => {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'task-tag task-tag--editable';
    chip.dataset.tagIndex = String(index);
    chip.setAttribute('aria-label', t('tasks.tagRemove', { tag }));
    chip.appendChild(document.createTextNode(tag));

    const icon = document.createElement('i');
    icon.setAttribute('data-lucide', 'x');
    icon.className = 'icon-sm';
    icon.setAttribute('aria-hidden', 'true');
    chip.appendChild(icon);

    wrap.appendChild(chip);
  });

  if (window.lucide) window.lucide.createIcons({ el: wrap });
}

/**
 * Verdrahtet den Tag-Editor: Enter oder Komma übernimmt, Klick auf ein Chip
 * entfernt, Backspace im leeren Feld nimmt das letzte zurück.
 */
function wireTagEditor(panel) {
  const input = panel.querySelector('#task-tag-input');
  const chips = panel.querySelector('#task-tags-chips');
  if (!input || !chips) return;

  const commit = () => {
    // Eine eingefügte Liste („Garten, Haus") in einem Rutsch übernehmen.
    const added = input.value.split(',');
    if (!added.some((v) => v.trim())) return;
    modalTags = normalizeTagList([...modalTags, ...added]);
    input.value = '';
    renderTagChips(panel);
  };

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ',') {
      // Enter darf im Tag-Feld nicht das Formular abschicken.
      e.preventDefault();
      commit();
      return;
    }
    if (e.key === 'Backspace' && !input.value && modalTags.length) {
      modalTags = modalTags.slice(0, -1);
      renderTagChips(panel);
    }
  });

  // Verlassen des Feldes übernimmt ebenfalls: sonst geht ein getippter Tag beim
  // Speichern still verloren.
  input.addEventListener('blur', commit);
  // Auswahl aus der Vorschlagsliste löst kein keydown aus.
  input.addEventListener('change', commit);

  chips.addEventListener('click', (e) => {
    const chip = e.target.closest('[data-tag-index]');
    if (!chip) return;
    modalTags.splice(Number(chip.dataset.tagIndex), 1);
    renderTagChips(panel);
  });
}

// Wie viele Tags eine Karte zeigt, bevor sie zusammenfasst. Analog zum
// Avatar-Stack: eine Karte, die 32 Etiketten ausrollt, ist keine Karte mehr.
const TAG_BADGES_VISIBLE = 3;

/* In der LISTENZEILE steht genau ein Etikett, im Kanban bleiben es drei: dort
 * ist die Karte die ganze Darstellung der Aufgabe und hat die Höhe dafür, hier
 * teilt sich das Etikett die Zeile mit Priorität, Fälligkeit und Avatar. */
const ROW_TAG_BADGES_VISIBLE = 1;

/**
 * Tag-Chips einer Aufgabe für Karten und Kanban.
 *
 * Die Chips sind Buttons, keine Beschriftungen: ein Tag anzuklicken und die
 * Liste darauf zu filtern ist die Geste, die man von einem Etikett erwartet.
 * Den Klick fängt die Delegation in wireTagBadgeFilter ab, die ihn auch vom
 * Karten-Klick (Aufgabe öffnen) trennt.
 */
/**
 * @param {string} [priority]  Die Priorität der Aufgabe, deren Etiketten das
 *   hier sind. Ein Etikett, das GENAU SO heisst wie sie, wird weggelassen.
 *
 * WARUM: gemessen stand auf /tasks der Prioritäts-Chip „• Dringend" direkt
 * neben dem gespiegelten CalDAV-Etikett „dringend" - zwei Formen, dasselbe
 * Wort, in einer Metazeile, die seit dem Zeilenschnitt einzeilig ist und jedes
 * Element bezahlt. Beide kommen aus derselben Quelle: eine VTODO trägt ihre
 * Dringlichkeit als PRIORITY und noch einmal als CATEGORIES.
 *
 * NUR DIE EIGENE PRIORITÄT, nicht jedes Prioritätswort: trägt eine Aufgabe mit
 * Priorität „hoch" ein Etikett „dringend", ist das keine Doppelung, sondern ein
 * Widerspruch - und den soll man sehen.
 *
 * Verglichen wird gegen das ANGEZEIGTE Label, nicht gegen den Schlüssel: das
 * Etikett kommt aus einer fremden Liste und ist in der Sprache geschrieben, in
 * der der Nutzer es dort angelegt hat.
 */
function renderTagBadges(tags, limit = TAG_BADGES_VISIBLE, priority = null) {
  if (!tags?.length) return '';
  const eigenes = priority && priority !== 'none' ? PRIORITY_LABELS()[priority] : null;
  if (eigenes) {
    const norm = (s) => String(s).trim().toLocaleLowerCase();
    tags = tags.filter((tag) => norm(tag) !== norm(eigenes));
    if (!tags.length) return '';
  }
  const shown = tags.slice(0, limit);
  const rest  = tags.length - shown.length;
  const chips = shown.map((tag) => `
    <button type="button" class="task-tag task-tag--filter" data-tag-filter="${esc(tag)}"
            aria-label="${esc(t('tasks.tagFilterBy', { tag }))}">${esc(tag)}</button>`);
  // Der Rest bleibt lesbar statt anklickbar: er benennt keinen einzelnen Tag,
  // also gäbe es auch nichts, worauf ein Klick filtern könnte.
  if (rest > 0) {
    chips.push(`<span class="task-tag task-tag--more"
                      title="${esc(tags.slice(limit).join(', '))}">+${rest}</span>`);
  }
  return chips.join('');
}

/**
 * Klick auf ein Tag-Chip filtert die Liste danach (#586).
 *
 * Delegiert, weil Karten laufend neu gezeichnet werden - und in der
 * Capture-Phase, nicht beim Bubbling. Im Kanban öffnet ein Klick irgendwo auf
 * der Karte den Bearbeiten-Dialog, und dieser Handler sitzt am Board, also
 * unterhalb des Containers: beim Bubbling käme er zuerst dran und hätte den
 * Dialog längst geöffnet, bevor ein stopPropagation hier noch etwas ausrichtet.
 */
function wireTagBadgeFilter(container) {
  container.addEventListener('click', async (e) => {
    const chip = e.target.closest('[data-tag-filter]');
    if (!chip || !container.contains(chip)) return;
    e.preventDefault();
    e.stopPropagation();
    await toggleTagFilter(chip.dataset.tagFilter, container);
  }, true);

  // Gruppenkopf auf- und zuklappen (#812).
  container.addEventListener('click', (e) => {
    const toggle = e.target.closest('[data-group-toggle]');
    if (!toggle || !container.contains(toggle)) return;
    toggleGroup(state.groupMode, toggle.dataset.groupToggle);
    renderTaskList(container);
  });
}

function renderModalContent({ task = null, users = [], reminder = null } = {}) {
  const isEdit = !!task;

  const selectedIds = task?.assigned_users?.map((u) => u.id) ?? (task?.assigned_to ? [task.assigned_to] : []);
  const visibility  = task?.visibility || 'all';

  const selectedCat = task?.category ?? FALLBACK_CATEGORY;
  const categoryOptions = state.categories.map((c) =>
    `<option value="${esc(c.key)}" ${selectedCat === c.key ? 'selected' : ''}>${esc(catLabel(c.key))}</option>`
  ).join('');

  const priorityOptions = PRIORITIES().map((p) =>
    `<option value="${p.value}" ${(task?.priority ?? 'none') === p.value ? 'selected' : ''}>${p.label}</option>`
  ).join('');

  // Punkte neuer Aufgaben mit dem Haushalt-Standard vorbelegen (#578).
  const prefillPoints = !isEdit && state.defaultPoints > 0 ? state.defaultPoints : 0;
  const pointsValue = isEdit
    ? (Number(task?.points) > 0 ? Number(task.points) : '')
    : (prefillPoints || '');

  /* WAS IN DER SEKTION STEHT, NENNT IHRE ZUSAMMENFASSUNG - dann muss sie nicht
   * auf (Critique 2026-08-10, P1 „Enterprise-SaaS-Antireferenz").
   *
   * Das Formular mass 29 Labels und `scrollHeight 1410` in `clientHeight 528`,
   * also 2,7 Bildschirme, um eine Aufgabe zu aendern - die haeufigste Handlung
   * der App auf ihrem ueberladensten Screen. Die progressive Offenlegung war
   * dabei nicht etwa nicht gebaut: sie war gebaut und abgeschaltet, und der
   * Schalter war diese eine Zeile.
   *
   * `advancedFieldsOpen` verlangte „einen Wert abseits der Defaults", zaehlte
   * dazu aber `category !== FALLBACK_CATEGORY`. Eine Kategorie hat fast jede
   * Aufgabe - die Bedingung war also praktisch immer wahr, und die Sektion kam
   * praktisch immer offen. Eine Regel, die jeden Fall zur Ausnahme erklaert,
   * hat keine Ausnahme mehr.
   *
   * Der Grund hinter der Bedingung war richtig: ein gesetzter Wert darf nicht
   * unsichtbar sein. Nur ist Aufklappen dafuer die teuerste Antwort. Das Muster
   * fuer die billige stand schon zwei Zeilen weiter unten - bei den
   * vorbelegten Punkten, wo der Aufklapper ZU blieb und die Zusammenfassung den
   * Wert nannte. Es gilt jetzt fuer alle Sekundaerfelder.
   *
   * Die Beschreibung traegt die Zusammenfassung nicht: sie ist Freitext, und
   * eine gekuerzte Notiz im Summary waere eine schlechtere Notiz. Sie steht
   * deshalb OBEN beim Titel - Titel und Notiz sichtbar, alles andere hinter
   * einem Einstieg, genau wie Apple Erinnerungen es haelt. */
  // Der Anfangswert des Statusfelds. Ein Bestandswert ausserhalb der Liste
  // (bis v1.86.2 stand 'archived' darin) faellt auf den ersten Status zurueck -
  // vorher waehlte in dem Fall der Browser die erste Option, waehrend die
  // Zusammenfassung noch den alten Wert nannte.
  const statusValue = STATUSES().find((s) => s.value === task?.status)?.value ?? STATUSES()[0].value;

  const advancedSummary = [];
  if (isEdit && task.priority && task.priority !== 'none') {
    advancedSummary.push(PRIORITY_LABELS()[task.priority] ?? task.priority);
  }
  if (isEdit && task.category && task.category !== FALLBACK_CATEGORY) {
    advancedSummary.push(catLabel(task.category));
  }
  if (isEdit && task.start_date) advancedSummary.push(formatDate(task.start_date));
  const summaryPoints = isEdit ? Number(task.points) : prefillPoints;
  if (summaryPoints > 0) advancedSummary.push(t('tasks.pointsSummary', { count: summaryPoints }));
  if (isEdit && task.tags?.length) advancedSummary.push(task.tags.join(', '));
  // Der Schwanz hinter dem Aufklapper ist eingezogen (Critique 2026-08-31):
  // Status, Sync-Ziel, Sichtbarkeit, Sperre und Anhaenge standen als offene
  // Feldgruppen NACH der Sektion - dieselbe Sorte Sekundaerfeld, nur an der
  // Regel vorbei. Sie stehen jetzt darin, und gesetzte Werte nennt die
  // Zusammenfassung, wie bei allen anderen. (Sync-Ziel fehlt in der Summary:
  // sein Anzeigename kommt asynchron aus /tasks/sync-targets.)
  if (statusValue !== STATUSES()[0].value) {
    advancedSummary.push(STATUSES().find((s) => s.value === statusValue).label);
  }
  if (!isSoloHousehold() && visibility !== 'all') advancedSummary.push(t(`common.visibility.${visibility}`));
  if (!isSoloHousehold() && task?.locked) advancedSummary.push(t('tasks.lockedBadge'));
  if (task?.documents?.length) advancedSummary.push(task.documents.map((d) => d.name).join(', '));

  const advancedLabel = advancedSummary.length
    ? `${t('modal.moreSettings')} · ${advancedSummary.join(' · ')}`
    : undefined;

  const advancedFieldsHtml = `
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

      <div class="modal-grid modal-grid--2" style="margin-top:var(--space-4)">
        <div class="form-group">
          <label class="label" for="task-start-date">${t('tasks.startDateLabel')}</label>
          <yuvomi-datepicker type="date" id="task-start-date" name="start_date"
                 value="${esc(formatDateInput(task?.start_date))}"></yuvomi-datepicker>
        </div>
        <div class="form-group">
          <label class="label" for="task-points">${t('tasks.pointsLabel')}</label>
          <input class="input" type="number" id="task-points" name="points" inputmode="numeric"
                 min="0" step="1" value="${pointsValue}"
                 placeholder="0">
          <p class="task-field-hint">${prefillPoints
            ? t('tasks.pointsDefaultHint', { count: prefillPoints })
            : t('tasks.pointsHint')}</p>
        </div>
      </div>

      <div class="form-group task-tags-field" style="margin-top:var(--space-4)">
        <label class="label" for="task-tag-input">${t('tasks.tagsLabel')}</label>
        <div class="task-tags-editor" id="task-tags-editor">
          <div class="task-tags-editor__chips" id="task-tags-chips"></div>
          <input class="input task-tags-editor__input" type="text" id="task-tag-input"
                 list="task-tag-suggestions" autocomplete="off"
                 placeholder="${t('tasks.tagsPlaceholder')}">
          <datalist id="task-tag-suggestions">
            ${state.allTags.map((entry) => `<option value="${esc(entry.tag)}"></option>`).join('')}
          </datalist>
        </div>
        <p class="task-field-hint">${t('tasks.tagsHint')}</p>
      </div>

      <!-- DAS FELD STAND BIS #807 NUR IM BEARBEITEN-ZWEIG. Vergessen war es
           nicht, aber die Annahme darunter stimmte nicht: notiert wird oft
           etwas, das laengst laeuft, und dafuer brauchte es bisher zwei
           Schritte - anlegen, wieder oeffnen, umstellen. Die Vorauswahl bleibt
           der erste Status, damit ein Anlegen, das das Feld nicht beruehrt,
           sich genau wie vorher verhaelt. -->
      <div class="form-group" style="margin-top:var(--space-4)">
        <label class="label" for="task-status">${t('tasks.statusLabel')}</label>
        <select class="input" id="task-status" name="status">
          ${STATUSES().map((s) =>
            `<option value="${s.value}" ${statusValue === s.value ? 'selected' : ''}>${s.label}</option>`
          ).join('')}
        </select>
      </div>
${syncTargetFieldHtml(task)}
      <!-- EINE QUELLE, NICHT ZWEI: die Bedingung war "users.length > 1" und
           beantwortete dieselbe Frage wie der Solo-Schalter, nur aus einer
           anderen Zahl - der geladenen Nutzerliste dieses Moduls statt der
           gezaehlten Haushaltsgroesse. Zwei Quellen fuer eine Frage laufen
           auseinander, sobald eine von beiden einen Sonderfall bekommt
           (Split-Gaeste zaehlen in der Nutzerliste mit, im Haushalt nicht).

           UND VERBORGEN, NICHT ENTFERNT - das ist hier kein Stilfrage, sondern
           die Regel selbst. Der Absende-Pfad liest
           "#task-visibility?.value || 'all'" (unten): ohne den Knoten schreibt
           JEDES Speichern im Solo-Haushalt "all" ueber den gespeicherten Wert,
           und eine als "private" angelegte Aufgabe verliert ihre Sichtbarkeit
           stillschweigend. Der Fehler steckte schon in der alten
           users.length-Bedingung; die Solo-Regel sagt ausdruecklich, dass sie
           keine Daten aendert (utils/household.js), also muss der Knoten
           stehenbleiben. Dokumente machen es an ihrer Stelle genauso. -->
      <div class="form-group" style="margin-top:var(--space-4)"${isSoloHousehold() ? ' hidden' : ''}>
        <label class="label" for="task-visibility">${t('common.visibility.label')}</label>
        <select class="input" id="task-visibility" name="visibility">
          <option value="all"       ${visibility === 'all'       ? 'selected' : ''}>${t('common.visibility.all')}</option>
          <option value="assignees" ${visibility === 'assignees' ? 'selected' : ''}>${t('common.visibility.assignees')}</option>
          <option value="private"   ${visibility === 'private'   ? 'selected' : ''}>${t('common.visibility.private')}</option>
        </select>
        <p class="task-field-hint">${t('common.visibility.hint')}</p>
        <p class="task-field-hint field-hint--warn" id="task-visibility-warning" role="status" hidden><i data-lucide="alert-triangle" aria-hidden="true"></i><span>${t('common.visibility.assigneesNobodyHint')}</span></p>
      </div>

      <!-- #830: Die Sperre steht neben der Sichtbarkeit, weil beide dieselbe
           Frage beantworten - wer darf hier was. Sichtbarkeit regelt das Sehen,
           die Sperre das Aendern. In einem Ein-Personen-Haushalt sagen beide
           nichts, also verschwinden sie zusammen (isSoloHousehold). -->
      <div class="form-group" style="margin-top:var(--space-4)"${isSoloHousehold() ? ' hidden' : ''}>
        <label class="toggle" style="margin:0">
          <input type="checkbox" id="task-locked" name="locked" aria-describedby="task-locked-hint"
                 ${task?.locked ? 'checked' : ''}>
          <span class="toggle__track"></span>
          <span>${t('tasks.lockedToggle')}</span>
        </label>
        <p class="task-field-hint" id="task-locked-hint">${t('tasks.lockedHint')}</p>
      </div>

      ${renderDocumentAttachField({
        attachments: (task?.documents ?? []).map((doc) => ({ document_id: doc.id, name: doc.name, mime_type: doc.mime_type })),
        label: t('tasks.documentsLabel'),
      })}`;

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

      <!-- Notiz steht beim Titel, nicht hinter dem Aufklapper: sie ist sein
           Gegenstueck, und eine Zusammenfassung kann Freitext nicht tragen.
           Genau deshalb sind zwei Zeilen zu wenig gewesen (#731): das Feld war
           auf die Groesse einer Zusammenfassung gebaut, obwohl der Kommentar
           darueber das Gegenteil begruendet. -->
      <div class="form-group">
        <label class="label" for="task-description">${t('tasks.descriptionLabel')}</label>
        ${renderMarkdownToolbar()}
        <textarea class="input" id="task-description" name="description"
                  rows="6" placeholder="${t('tasks.descriptionPlaceholder')}"
                 >${esc(task?.description)}</textarea>
        <small class="form-hint">${t('tasks.descriptionMarkdownHint')}</small>
      </div>

      <div class="modal-grid modal-grid--2">
        <div class="form-group">
          <label class="label" for="task-due-date">${t('tasks.dueDateLabel')}</label>
          <yuvomi-datepicker type="date" id="task-due-date" name="due_date"
                 value="${esc(formatDateInput(task?.due_date))}"></yuvomi-datepicker>
        </div>
        <div class="form-group">
          <label class="label" for="task-due-time">${t('tasks.dueTimeLabel')}</label>
          <yuvomi-datepicker type="time" id="task-due-time" name="due_time"
                 value="${esc(formatTimeInput(task?.due_time ?? ''))}"></yuvomi-datepicker>
        </div>
      </div>

      <!-- „Zugewiesen an" bot einer Solo-Nutzerin eine Chip-Reihe mit ihr selbst
           und „- Niemand -" (Critique 2026-08-10). Das Feld bleibt im DOM und
           behaelt seinen Wert, es wird nur verborgen - der Absende-Pfad liest
           es unveraendert (utils/household.js). -->
      <div class="form-group" style="margin-top:var(--space-4)"${isSoloHousehold() ? ' hidden' : ''}>
        ${renderUserMultiSelect(users, selectedIds, 'task_assigned', 'tasks.assignedLabel')}
      </div>

      <!-- #647: die Haelfte, die @jamespurnama1 beschrieben hat. Fuehrerschein
           und Luftfilter sind keine Termine, und ihre Ruecksetzung haengt an
           einer DAUER, nicht an einem Datum - das ist genau eine wiederkehrende
           Aufgabe „ab Erledigung" (#658), die es hier schon gibt. Der Schalter
           haengt deshalb an der Aufgabe und nicht an einem dritten Objekt.
           Im Hauptbereich aus demselben Grund wie im Kalender: hinter dem
           Aufklapper faende ihn niemand, der nicht danach sucht. -->
      <div class="form-group" style="margin-top:var(--space-4)">
        <label class="toggle" style="margin:0">
          <input type="checkbox" id="task-countdown" name="countdown" aria-describedby="task-countdown-hint"
                 ${task?.countdown ? 'checked' : ''}>
          <span class="toggle__track"></span>
          <span>${t('tasks.countdownToggle')}</span>
        </label>
        <p class="task-field-hint" id="task-countdown-hint">${t('tasks.countdownHint')}</p>
        <!-- DER SCHALTER SPERRT SICH SELBST, statt sich auf die Zeile darueber
             zu verlassen. Ein Hinweis ist keine Fehlervermeidung: ohne
             Faelligkeit war der Schalter voll bedienbar, speicherte, meldete
             „Aufgabe erstellt." - und der Countdown erschien nie. Wer sich
             darauf verlaesst, erfaehrt es, wenn die Frist vorbei ist. -->
        <p class="task-field-hint field-hint--warn" id="task-countdown-warning" role="status" hidden><i data-lucide="alert-triangle" aria-hidden="true"></i><span>${t('tasks.countdownNeedsDue')}</span></p>
      </div>

      ${advancedSection(advancedFieldsHtml, { label: advancedLabel })}

      ${renderRRuleFields('task', task?.recurrence_rule, {
        allowFromCompletion: true,
        fromCompletion: !!task?.recurrence_from_completion,
        // AUSDRUECKLICH FALSE, nicht weggelassen (#960). Eine Aufgabe ist eine
        // Zeile mit einem Faelligkeitsdatum, das Liste, Ueberfaelligkeit und
        // Countdown direkt lesen - sie wird nicht wie eine Kalenderserie vom
        // Startdatum aus expandiert. Der Monatsletzten-Hinweis muss das sagen,
        // sonst verspricht er einen Termin, den es hier nicht gibt.
        expandsFromStart: false,
      })}

      ${renderReminderSection(task, reminder)}

      <div id="task-form-error" class="form-error" role="alert" hidden></div>

      <div class="modal-panel__footer modal-panel__footer--plain">
        ${isEdit ? `
          <button type="button" class="btn btn--danger-outline" data-action="delete-task"
                  data-id="${task.id}" style="margin-right:auto">${t('common.delete')}</button>` : ''}
        <button type="button" class="btn btn--ghost" data-action="close-modal">${t('common.cancel')}</button>
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
  // Das Fehlerobjekt des letzten Ladeversuchs, oder null. Nicht `true`:
  // `mountLoadError` liest daraus den Statuscode.
  loadError:       null,
  // Der angemeldete Nutzer, wie ihn render() bekommt. Gehalten fuer den
  // Wiederholen-Weg des Ladefehlers: aus `currentUserId` allein liesse sich
  // `isAdmin` nicht rekonstruieren, und der Retry haette die Rechte gesenkt.
  user:            null,
  users:           [],
  categories:      [],
  allTags:         [],       // [{ tag, count }] für Filterleiste und Vorschläge (#586)
  /** Welche Referenzlisten sind gerade NICHT nachweislich frisch?
   *
   *  Zwei Wege dorthin, und beide enden gleich. Erstens der Offline-Cache:
   *  `/tasks` steht in `API_CACHE_WHITELIST` (sw.js), also auch
   *  `/tasks/meta/options`, `/tasks/tags` und `/tasks/categories` - und
   *  `networkFirstApi` antwortet bei Netzfehler mit dem Cache und Status 200.
   *  Zweitens eine fehlgeschlagene Auffrischung, die die alte Liste stehen
   *  laesst (`refreshTags`). In beiden Faellen sind die Listen beliebig alt,
   *  und eine Filterentscheidung darauf ist keine. Siehe `getRecentFilters`.
   *
   *  Deshalb heisst das Feld nicht `metaFromCache`: der Cache ist nur der
   *  haeufigere der beiden Wege.
   *
   *  UND JE LISTE, nicht als ein Flag fuer drei. Die drei Endpunkte sind
   *  getrennte Cache-Eintraege und werden getrennt aufgefrischt: `refreshTags`
   *  holt nur `/tasks/tags`, der Kategorie-Manager nur `/tasks/categories`,
   *  und allein `/tasks/meta/options` bringt alle drei. Als EIN gemeinsames
   *  Flag erklaerte eine netzfrische Tag-Auffrischung die noch gecachten
   *  Kategorien und Mitglieder fuer autoritativ - und das Beschneiden warf
   *  dann ein Chip weg, das es noch gibt. */
  metaStale:       { users: false, categories: false, tags: false },
  defaultPoints:   0,        // Haushalt-Standard für neue Aufgaben (#578), 0 = aus
  currentUserId:   null,
  isAdmin:         false,    // darf fremde Kommentare entfernen (#734)
  // `tags` ist eine Liste, keine Auswahl: mehrere Tags engen UND-verknüpft ein,
  // wie jeder andere Filter in dieser Leiste auch (#586).
  // Status, Priorität und Person halten mehrere Werte (#671); innerhalb einer
  // Achse wirken sie ODER, zwischen den Achsen UND. Tags bleiben UND-verknüpft.
  filters:         { status: ['open'], priority: [], assigned_to: [], category: [], tags: [] },
  groupMode:       'category',   // 'category' | 'due'
  viewMode:        'list',       // 'list' | 'kanban' | 'history' (resolved at render time)
  // Der Verlauf (#791) hat einen eigenen Bestand, weil er etwas anderes zeigt
  // als `tasks`: nicht Aufgaben, sondern Vorgänge. Er wird geblättert statt
  // gefiltert - deshalb ein Cursor und kein Seitenindex.
  history:         { entries: [], hasMore: false, cursor: null, userId: null, loading: null, error: null },
  showFuture:      false,
  subtasksExpandedByDefault: false,
  // Persönliche Standard-Erinnerungsliste für neue Aufgaben (#695), leer = nur
  // lokal. Wird beim Öffnen des Dialogs als Vorauswahl gesetzt.
  defaultSyncTarget: '',
  expandedTasks:   new Set(),
  // Eingeklappte Gruppen (#812), als "<modus>:<gruppen-id>" - derselbe Name
  // kann in beiden Gruppierungen vorkommen und meint dort Verschiedenes.
  collapsedGroups: new Set(),
  filterPanelOpen: false,
  bulkSelectMode:  false,
  selectedTaskIds: new Set(),
  searchQuery:     '',
};

/**
 * Aufgaben nach der Toolbar-Suche gefiltert. Rein clientseitig über Titel und
 * Beschreibung — die Serverfilter (Status/Priorität/Person) laufen weiter über
 * loadTasks(). state.tasks bleibt ungefiltert, damit Zähler wie das
 * Überfällig-Badge die Gesamtlage melden und nicht die Suchtreffer.
 */
function filteredTasks() {
  const q = state.searchQuery.trim().toLowerCase();
  if (!q) return state.tasks;
  return state.tasks.filter((task) =>
    (task.title       || '').toLowerCase().includes(q) ||
    (task.description || '').toLowerCase().includes(q) ||
    (task.tags ?? []).some((tag) => tag.toLowerCase().includes(q))
  );
}

// --------------------------------------------------------
// API-Aktionen
// --------------------------------------------------------

/**
 * Query-String für /tasks aus dem aktuellen Filterzustand.
 *
 * Geteilt zwischen dem ersten Aufbau der Seite und jedem Nachladen: die Liste
 * stand zweimal da und ist beim Hinzukommen des Tag-Filters prompt
 * auseinandergelaufen.
 */
function taskQuery() {
  const params = new URLSearchParams();
  // Kanban-Spalten SIND der Status: den Statusfilter dort nicht an den Server
  // senden, sonst blieben "In Bearbeitung"/"Erledigt" trotz vorhandener Aufgaben
  // leer (Audit A1-07/P3). In der Liste wirkt er normal; state bleibt erhalten,
  // sodass der Filter beim Zurückwechseln wieder greift.
  // append statt set: jeder Wert ist ein eigener Parameter. Bei den Tags, damit
  // ein Tag mit Komma im Namen am Server nicht in zwei zerfällt; bei den übrigen
  // Achsen, weil sie seit #671 mehrere Werte tragen (ODER-verknüpft).
  if (state.viewMode !== 'kanban') state.filters.status.forEach((v) => params.append('status', v));
  // Im Kanban ist die Ablage eine Spalte — sie muss also mitkommen, obwohl der
  // Server sie sonst ausblendet (#688).
  else params.set('archived', '1');
  state.filters.priority.forEach((v) => params.append('priority', v));
  state.filters.assigned_to.forEach((v) => params.append('assigned_to', v));
  // Der Server kannte die Achse schon (normalizeCategoryFilter, mehrere Werte
  // ODER-verknuepft); nur das Panel hatte sie nie angeboten (D#1017).
  state.filters.category.forEach((v) => params.append('category', v));
  state.filters.tags.forEach((tag) => params.append('tag', tag));
  if (state.showFuture)          params.set('include_future', '1');
  return params.toString() ? `?${params}` : '';
}

async function loadTasks(container) {
  // Ohne Container steht diese Seite gar nicht - die Aufgabe wurde von der
  // Uebersicht oder aus dem Kalender geoeffnet (#918), und dort frischt der
  // Aufrufer seine eigene Ansicht auf.
  if (!container) return;
  persistAssignedToMe();
  const data  = await api.get(`/tasks${taskQuery()}`);
  state.tasks = data.data ?? [];
  renderTaskList(container);
}

/**
 * Vergebene Tags nachladen (#586). Nur nach dem Speichern nötig, nicht bei jedem
 * Filterwechsel - die Liste ändert sich ausschließlich durch Bearbeiten.
 * Scheitert der Aufruf, bleibt die alte Liste stehen: veraltete Vorschläge sind
 * harmloser als eine plötzlich verschwundene Filtergruppe.
 */
async function refreshTags() {
  try {
    const { data, fromCache } = await api.getWithSource('/tasks/tags');
    state.allTags = data.data ?? [];
    // NUR die Tags: ueber Kategorien und Mitglieder sagt dieser Rundlauf
    // nichts, ihr Zustand bleibt, wie er war.
    state.metaStale.tags = fromCache === true;
  } catch {
    // Alte Liste behalten - aber sie ist ab jetzt nicht mehr nachweislich
    // frisch, und `getRecentFilters` darf nicht mehr dagegen beschneiden.
    state.metaStale.tags = true;
  }
}

async function toggleTaskStatus(id, currentStatus) {
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

// Blendet einen Hinweis ein, wenn „Nur Zugewiesene" gewählt ist, aber niemand
// zugewiesen wurde — dann sieht faktisch nur der Ersteller den Eintrag (#474 Guard).
function wireVisibilityWarning(panel, selectSel, msName, warnSel) {
  const select = panel.querySelector(selectSel);
  const warn   = panel.querySelector(warnSel);
  if (!select || !warn) return;
  const ms = panel.querySelector(`.user-ms[data-ms-name="${msName}"]`);
  const update = () => {
    const count = getSelectedUserIds(panel, msName).length;
    warn.hidden = !(select.value === 'assignees' && count === 0);
  };
  select.addEventListener('change', update);
  ms?.addEventListener('click', () => setTimeout(update, 0));
  update();
}

/**
 * Der Countdown-Schalter haengt an der Faelligkeit (#647).
 *
 * GESPERRT UND NICHT NUR BESCHRIFTET. Die Hilfszeile sagte „Braucht ein
 * Faelligkeitsdatum" und der Schalter liess sich trotzdem setzen: gespeichert
 * wurde `countdown: 1` bei `due_date: null`, der Toast meldete Erfolg, und der
 * Eintrag erschien nie auf der Uebersicht. Ein Hinweis erklaert einen Fehler,
 * er verhindert ihn nicht.
 *
 * Der Haken wird beim Sperren MITGENOMMEN, nicht stehengelassen: ein
 * abgehakter, grauer Schalter behauptet einen Zustand, den der Server nicht
 * kennt. Wer die Faelligkeit wieder setzt, findet ihn aus - das ist ehrlicher
 * als ein Haken, der zurueckkommt, ohne dass jemand ihn gesetzt hat.
 *
 * `yuvomi-datepicker` meldet seine Aenderung als `change` am eigenen Element;
 * `input` kommt aus dem inneren Feld beim Tippen. Beide anhoeren, sonst haengt
 * der Schalter je nach Bedienweg (Kalenderblatt vs. Tastatur) hinterher.
 */
function wireCountdownGate(panel) {
  const toggle = panel.querySelector('#task-countdown');
  const due    = panel.querySelector('#task-due-date');
  const warn   = panel.querySelector('#task-countdown-warning');
  if (!toggle || !due) return;
  const update = () => {
    const hasDue = !!parseDateInput(due.value || '');
    if (!hasDue && toggle.checked) toggle.checked = false;
    toggle.disabled = !hasDue;
    if (warn) warn.hidden = hasDue;
  };
  due.addEventListener('change', update);
  due.addEventListener('input', update);
  update();
}

function openTaskModal({ task = null, users = [], reminder = null } = {}, container) {
  const isEdit = !!task;
  // Working-Set VOR dem Rendern setzen: renderTagChips liest ihn direkt danach.
  modalTags = normalizeTagList(task?.tags);
  openSharedModal({
    title: isEdit ? t('tasks.editTask') : t('tasks.newTask'),
    content: renderModalContent({ task, users, reminder }),
    size: 'lg',
    // Eine neue Aufgabe startet weiterhin mit dem Fokus im Titelfeld - hier ist
    // Tippen die Absicht.
    onSave(panel) { wireTaskForm(panel, { task, container }); },
  });
}

/**
 * Verdrahtet das Aufgaben-Formular. Eigene Funktion, weil das Formular an zwei
 * Orten entsteht: als eigenes Modal (neue Aufgabe) und als zweites Pane der
 * Detailansicht, das erst beim Wechsel gemountet wird.
 */
/**
 * Die Dokument-Sichtbarkeit, die zur Sichtbarkeit der Aufgabe passt.
 *
 * Die beiden Vokabulare sind nicht dasselbe: eine Aufgabe kennt
 * `all|assignees|private`, ein Dokument `family|restricted|private`. Uebersetzt
 * wird auf die jeweils engere Entsprechung - eine offene Aufgabe teilt ihren
 * Anhang mit dem Haushalt, eine private behaelt ihn, und „nur Beteiligte" wird
 * zur ausdruecklichen Freigabeliste.
 */
function taskDocumentVisibility(panel) {
  const value = panel.querySelector('#task-visibility')?.value || 'all';
  if (value === 'private') return 'private';
  if (value === 'assignees') return 'restricted';
  return 'family';
}

/**
 * @param {HTMLElement} panel
 * @param {{task?: object|null, container?: HTMLElement|null,
 *          onChanged?: () => (void|Promise<void>)}} opts
 *        `onChanged` frischt auf, was nach dem Speichern anders aussieht.
 *        Voreingestellt ist die Liste dieser Seite; wer das Formular von
 *        aussen mountet (#918, openTaskById), setzt seine eigene Ansicht ein -
 *        die Uebersicht haelt keine Aufgabenliste, die sich neu zeichnen liesse.
 */
function wireTaskForm(panel, { task = null, container = null, onChanged = () => loadTasks(container) }) {
  panel.querySelector('.modal-panel__body')?.classList.add('modal-panel__body--tasks-fit');
  // RRULE-Events binden
  bindRRuleEvents(document, 'task');
  bindUserMultiSelect(panel, 'task_assigned');
  wireVisibilityWarning(panel, '#task-visibility', 'task_assigned', '#task-visibility-warning');
  wireCountdownGate(panel);

  // Tag-Editor (#586)
  renderTagChips(panel);
  wireTagEditor(panel);

  // Formatierungsleiste ueber der Notiz (#731). Die Leseansicht rendert sie
  // seit v2.7.0 als Markdown, geschrieben werden musste sie aber von Hand -
  // dieselbe Leiste, die die Notizen seit jeher haben, dieselbe Datei.
  const description = panel.querySelector('#task-description');
  if (description) wireMarkdownToolbar(panel, description);

  // Verknüpfte Dokumente: hochladen oder ein abgelegtes wählen (#503, #733).
  // Die Vorbelegung steckt bereits im Markup (task.documents aus GET /tasks/:id),
  // hier wird nur noch verdrahtet.
  taskDocuments = bindDocumentAttachField(panel, {
    category: 'other',
    folderKey: 'tasks',
    folderName: t('documents.tasksFolder'),
    // Die Datei erbt die Sichtbarkeit ihrer Aufgabe. Ohne das laege der Beleg
    // einer PRIVATEN Aufgabe als familiensichtbares Dokument im Dokumente-Modul:
    // die Aufgabe waere verborgen, der Zettel darin fuer alle lesbar. Bei
    // „nur Beteiligte" traegt das Dokument dieselbe Liste - `restricted` mit den
    // zugewiesenen Personen. Ausgewertet wird erst beim Hochladen, weil das
    // Sichtbarkeitsfeld bis dahin noch umgestellt werden kann.
    //
    // Eine MOMENTAUFNAHME, kein Dauerabgleich: wechselt die Aufgabe spaeter ihre
    // Sichtbarkeit oder ihre Zuweisungen, bleibt die Freigabe des Dokuments
    // stehen. Sie nachzuziehen hiesse, in Dokumente hineinzuschreiben, wo die
    // Datei danach lebt und wo sie jemand bewusst anders freigegeben haben kann
    // - eine Aufgabenzuweisung darf keine fremde Freigabe ueberschreiben.
    visibility: () => taskDocumentVisibility(panel),
    // Wer die Aufgabe sieht, sieht ihren Anhang: bei „nur Beteiligte" sind das
    // die Zugewiesenen UND die Person, die die Aufgabe angelegt hat. Ohne sie
    // laedt eine zugewiesene Person eine Datei hoch, und der Ersteller - der die
    // Aufgabe oeffnen darf - findet dort eine Zeile weniger als vorhanden ist.
    allowedMemberIds: () => {
      const ids = getSelectedUserIds(panel, 'task_assigned').map(Number);
      const creator = Number(task?.created_by ?? state.currentUserId);
      if (Number.isInteger(creator) && !ids.includes(creator)) ids.push(creator);
      return ids;
    },
  });

  // Sync-Ziel nachladen (#695). Ohne await: die Liste kommt aus dem Netz, und
  // bis sie da ist, steht "nur lokal" - das ist der richtige Zwischenzustand.
  wireSyncTarget(panel, task);

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
  // Form-Events
  panel.querySelector('#task-form')
    ?.addEventListener('submit', (e) => handleFormSubmit(e, { container, onChanged }));

  panel.querySelector('[data-action="delete-task"]')
    ?.addEventListener('click', (e) => deleteTaskWithUndo(e.currentTarget.dataset.id, {
      container, onChanged,
    }));
}

// --------------------------------------------------------
// Tag-Verwaltung und Bulk-Vergabe (#586)
// --------------------------------------------------------

/**
 * Tags haushaltsweit umbenennen, zusammenführen und entfernen.
 * Nach jeder Änderung wandert die frische Liste direkt in den State - der
 * Server liefert sie in derselben Antwort mit, ein Nachladen entfällt.
 */
function openTagManager(container) {
  let manager = null;
  const onChanged = async (e) => {
    state.allTags = e.detail?.tags ?? state.allTags;
    // Ein Tag, der gerade umbenannt oder gelöscht wurde, kann noch im Filter
    // stehen. Bliebe er dort, filterte die Liste auf einen Namen, den es nicht
    // mehr gibt, und zeigte dauerhaft nichts an.
    const known = new Set(state.allTags.map((entry) => entry.tag.toLowerCase()));
    state.filters.tags = state.filters.tags.filter((tag) => known.has(tag.toLowerCase()));
    renderFilters(container);
    await loadTasks(container);
  };
  openSharedModal({
    title: t('tasks.manageTags'),
    content: '<yuvomi-tag-manager></yuvomi-tag-manager>',
    size: 'lg',
    onSave: (panel) => {
      manager = panel.querySelector('yuvomi-tag-manager');
      manager.addEventListener('tag-manager-changed', onChanged);
    },
    onClose: () => manager?.removeEventListener('tag-manager-changed', onChanged),
  });
}

/**
 * Tag an die ausgewählten Aufgaben hängen oder von ihnen nehmen.
 *
 * Beim Entfernen kommen die Vorschläge aus den ausgewählten Aufgaben selbst,
 * nicht aus dem Gesamtbestand: einen Tag anzubieten, den keine der markierten
 * Aufgaben trägt, wäre eine Aktion, die garantiert nichts tut.
 */
function openBulkTagDialog(taskIds, mode, container) {
  const selected = state.tasks.filter((task) => taskIds.includes(task.id));
  const pool = mode === 'remove'
    ? [...new Map(selected.flatMap((task) => task.tags ?? [])
        .map((tag) => [tag.toLowerCase(), tag])).values()].sort((a, b) =>
          a.localeCompare(b, getLocale(), { sensitivity: 'base' }))
    : state.allTags.map((entry) => entry.tag);

  openSharedModal({
    title: mode === 'add' ? t('tasks.bulkTagAdd') : t('tasks.bulkTagRemove'),
    size: 'sm',
    content: `
      <form id="bulk-tag-form">
        <div class="form-group">
          <label class="label" for="bulk-tag-input">${t('tasks.tagsLabel')}</label>
          <input class="input" type="text" id="bulk-tag-input" name="tag" autocomplete="off"
                 list="bulk-tag-suggestions" maxlength="64"
                 placeholder="${t('tasks.tagsPlaceholder')}">
          <datalist id="bulk-tag-suggestions">
            ${pool.map((tag) => `<option value="${esc(tag)}"></option>`).join('')}
          </datalist>
          <p class="task-field-hint">${t('tasks.bulkTagHint', { count: taskIds.length })}</p>
        </div>
        <div class="modal-actions">
          <button type="submit" class="btn btn--primary">${t('common.apply')}</button>
        </div>
      </form>`,
    onSave: (panel) => {
      const form = panel.querySelector('#bulk-tag-form');
      panel.querySelector('#bulk-tag-input')?.focus();
      form?.addEventListener('submit', async (e) => {
        e.preventDefault();
        const tag = form.elements.tag.value.trim();
        if (!tag) return;
        try {
          const body = mode === 'add' ? { ids: taskIds, add: [tag] } : { ids: taskIds, remove: [tag] };
          const res = await api.post('/tasks/tags/apply', body);
          state.allTags = res.data?.tags ?? state.allTags;
          // Der Server ueberspringt gesperrte Aufgaben, statt den ganzen Aufruf
          // abzuweisen (#830). Eine stille Teilausfuehrung waere schlimmer als
          // ein Fehler, also sagt der Toast, was liegen blieb.
          const skipped = res.data?.skipped ?? 0;
          window.yuvomi.showToast(
            skipped
              ? `${t('tasks.tagsUpdated', { count: res.data?.updated ?? 0 })} ${t('tasks.tagsSkippedLocked', { count: skipped })}`
              : t('tasks.tagsUpdated', { count: res.data?.updated ?? 0 }),
            'success');
          closeModal({ force: true });
          state.selectedTaskIds.clear();
          updateBulkActionsBar(container);
          renderFilters(container);
          await loadTasks(container);
          refocusAfterRender();
        } catch (err) {
          window.yuvomi.showToast(err.message ?? t('common.errorGeneric'), 'danger');
        }
      });
    },
  });
}

// --------------------------------------------------------
// Kategorie-Verwaltung (#494)
// --------------------------------------------------------

function openTaskCategoryManager(container) {
  // Die Auffrischung haengt am Ereignis, nicht am Schliessen: beim Loeschen
  // raeumt `confirmOverModal` das Modal darunter ab, bevor `api.delete` laeuft
  // (siehe `_notifyChanged` in components/category-manager.js).
  const onChanged = async () => {
    try {
      const { data, fromCache } = await api.getWithSource('/tasks/categories');
      state.categories = data.data ?? [];
      state.metaStale.categories = fromCache === true;
      // Loeschbar ist die UNBENUTZTE Kategorie, also gerade die, nach der jemand
      // gefiltert haben kann. Bliebe ihr Key in `state.filters.category`, fragte
      // die Seite den Server weiter nach einer Kategorie, die es nicht mehr
      // gibt: dauerhaft leere Liste, dazu ein Chip, der sie weiter benennt.
      const bekannt = new Set(state.categories.map((c) => c.key));
      const behalten = state.filters.category.filter((key) => bekannt.has(key));
      const filterBereinigt = behalten.length !== state.filters.category.length;
      state.filters.category = behalten;
      // Die Leiste IMMER neu bauen, nicht nur beim Bereinigen: das Filter-Panel
      // kann hinter dem Manager offen stehen. Es boete sonst weiter die eben
      // geloeschte Kategorie zur Auswahl an - ein Klick darauf installierte den
      // toten Key erneut -, und nach Umbenennen oder Anlegen stuenden dort die
      // alten Namen.
      renderFilters(container);
      if (filterBereinigt) {
        await loadTasks(container); // die Abfrage hat sich geaendert; laedt und rendert
        return;
      }
      renderTaskList(container);
    } catch (err) {
      // NICHT „meldet der Manager selbst": der quittiert nur seine eigene
      // Mutation, und `_notifyChanged()` kommt erst nach deren Erfolg. Was hier
      // ankommt, ist immer ein Fehler DIESER Auffrischung - und der erklaert als
      // einziger, warum die Seite den alten Stand behaelt.
      console.error('[Tasks] Auffrischen nach Kategorie-Aenderung fehlgeschlagen:', err);
      window.yuvomi?.showToast(err.data?.error ?? t('common.errorGeneric'), 'danger');
    }
  };
  openSharedModal({
    title: t('tasks.manageCategories'),
    content: '<yuvomi-category-manager></yuvomi-category-manager>',
    size: 'lg',
    onSave: (panel) => {
      const manager = panel.querySelector('yuvomi-category-manager');
      manager.addEventListener('category-manager-changed', onChanged);
      manager.configure({
        basePath: '/tasks/categories',
        groups: [{ key: '', addLabelKey: 'tasks.addCategory' }],
        labelResolver: (item) => (item.label_key ? t(item.label_key) : (item.name || item.key)),
        titleKey: 'tasks.manageCategories',
        hintKey: 'category.manageHint',
        deleteDetailKey: 'category.deleteConfirmDetail',
      });
    },
    // Bewusst KEIN onClose, das den Listener abmeldet - es liefe vor dem
    // Loeschen. Das Element entsteht je Oeffnen neu und geht mit dem Overlay.
  });
}

// --------------------------------------------------------
// Formular-Handler
// --------------------------------------------------------

async function handleFormSubmit(e, { container = null, onChanged = () => loadTasks(container) } = {}) {
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
  // Ein noch nicht übernommener Tag im Eingabefeld zählt mit — wer tippt und
  // direkt speichert, hat ihn gemeint.
  const pendingTag = form.querySelector('#task-tag-input')?.value ?? '';
  const tags = normalizeTagList([...modalTags, ...pendingTag.split(',')]);

  const body = {
    title:           form.title.value.trim(),
    description:     form.description.value.trim() || null,
    priority:        form.priority.value,
    category:        form.category.value,
    tags,
    start_date:      startDate || null,
    due_date:        dueDate || null,
    assigned_to:     getSelectedUserIds(form, 'task_assigned'),
    visibility:      form.querySelector('#task-visibility')?.value || 'all',
    is_recurring:    rrule.is_recurring ? 1 : 0,
    recurrence_rule: rrule.recurrence_rule,
    recurrence_from_completion: rrule.recurrence_from_completion ? 1 : 0,
    countdown:       form.querySelector('#task-countdown')?.checked ? 1 : 0,
    locked:          form.querySelector('#task-locked')?.checked ? 1 : 0,
    points:          Math.max(0, Math.trunc(Number(form.points?.value)) || 0),
  };
  // Das Feld fehlt bei Unteraufgaben und bei bereits gespiegelten Aufgaben - in
  // beiden Fällen soll gar kein Ziel mitgeschickt werden, sonst nähme der Server
  // das Fehlen als "auf lokal zurücksetzen" (#695).
  const syncTargetField = form.querySelector('#task-sync-target');
  if (syncTargetField) body.sync_target = syncTargetField.value;
  const dueTimeRaw = form.due_time?.value || '';
  const dueTime = parseTimeInput(dueTimeRaw);
  const resetSubmit = (msg) => {
    errorEl.textContent = msg;
    errorEl.hidden = false;
    submitBtn.disabled = false;
    submitBtn.textContent = originalLabel;
  };
  if (dueTimeRaw && !dueTime) { resetSubmit(t('calendar.invalidDate')); return; }
  body.due_time = dueTime || null;
  if (form.status) body.status = form.status.value;

  // Erinnerungs-Vorbedingungen VOR dem Speichern prüfen — verhindert den
  // widersprüchlichen Zustand "Aufgabe gespeichert (Erfolgs-Toast) + roter
  // Fehler", wenn Reminder ohne Fälligkeit/Offset gesetzt wird (Critique P2).
  const wantsReminder = !!reminderToggle?.checked;
  let remindAt = null;
  if (wantsReminder) {
    if (!dueDate) { resetSubmit(t('tasks.reminderNeedsDueDate')); return; }
    const offsetPreset = form.querySelector('#reminder-offset')?.value || 'offset_none';
    if (offsetPreset === 'offset_none') { resetSubmit(t('tasks.reminderNeedsDueDate')); return; }
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
      if (!Number.isFinite(customAmount) || customAmount <= 0) { resetSubmit(t('common.invalidInput')); return; }
      const unitFactor = customUnit === 'minutes' ? 60000 : customUnit === 'hours' ? 3600000 : customUnit === 'days' ? 86400000 : 604800000;
      offsetMs = customAmount * unitFactor;
    }
    const dueDateTime = body.due_time ? new Date(`${dueDate}T${body.due_time}`) : new Date(`${dueDate}T23:59:59`);
    remindAt = new Date(dueDateTime.getTime() - offsetMs).toISOString().slice(0, 19);
  }

  // Wartende Uploads VOR dem Speichern der Aufgabe (#733): scheitert der
  // Upload, soll die Aufgabe nicht mit dem Gefühl gespeichert sein, der Beleg
  // hänge dran. Dasselbe Vorgehen wie bei den Belegen im Budget.
  // null heißt „kein Feld im Formular" und ist NICHT dasselbe wie „keine
  // Dokumente": ein PUT mit leerer Liste löscht als Replace-Set alles, was an
  // der Aufgabe hängt.
  let documentIds = null;
  try {
    documentIds = taskDocuments ? await taskDocuments.commit() : null;
  } catch (err) {
    resetSubmit(err.message || t('common.errorGeneric'));
    btnError(submitBtn);
    return;
  }

  try {
    let savedTaskId = taskId;
    if (taskId) {
      await api.put(`/tasks/${taskId}`, body);
      window.yuvomi.showToast(t('tasks.savedToast'), 'success');
    } else {
      const res = await api.post('/tasks', body);
      savedTaskId = res.data?.id;
      window.yuvomi.showToast(t('tasks.createdToast'), 'success');
    }

    // Erinnerung speichern oder löschen (Vorbedingungen bereits oben geprüft)
    if (savedTaskId) {
      if (wantsReminder) {
        await api.post('/reminders', { entity_type: 'task', entity_id: savedTaskId, remind_at: remindAt });
        refreshReminders();
      } else {
        try {
          await api.delete(`/reminders?entity_type=task&entity_id=${savedTaskId}`);
          refreshReminders();
        } catch { /* kein Reminder vorhanden - ignorieren */ }
      }

      // Dokument-Verknüpfungen als Replace-Set übernehmen (#503).
      //
      // Der Fehler wird nicht mehr verschluckt: seit hier hochgeladen werden
      // kann (#733), liegt bei einem Fehlschlag eine frische Datei unverknüpft
      // im Dokumente-Modul, während die Aufgabe sich als gespeichert meldet -
      // der Nutzer glaubt, der Zettel hänge dran. Die Aufgabe IST gespeichert,
      // deshalb bleibt das kein Abbruch, sondern eine Meldung, die den einen
      // Teil benennt, der nicht geklappt hat.
      if (documentIds) {
        try {
          await api.put(`/tasks/${savedTaskId}/documents`, { document_ids: documentIds });
        } catch (err) {
          console.error('[Tasks] document link error:', err);
          // Das Formular bleibt STEHEN: die Aufgabe ist gespeichert, aber die
          // Datei haengt nicht an ihr, und ein zuklappendes Modal mit gruenem
          // Haken behauptete das Gegenteil. So bleibt der Weg zum zweiten
          // Versuch offen - die Chips sind noch da, ein erneutes Speichern
          // schickt dieselbe Liste.
          resetSubmit(t('tasks.documentsLinkFailed'));
          btnError(submitBtn);
          await refreshTags();
          await onChanged();
          return;
        }
      }
    }

    btnSuccess(submitBtn, originalLabel);
    setTimeout(() => closeModal({ force: true }), 700);
    // Erst die Tag-Liste, dann neu zeichnen: ein gerade vergebener Tag soll
    // sofort in Filterleiste und Vorschlägen stehen (#586).
    await refreshTags();
    await onChanged();
  } catch (err) {
    resetSubmit(err.message);
    btnError(submitBtn);
  }
}

// Ein Teilschritt ist eine gewöhnliche Aufgabe mit parent_task_id, also tragen
// Umbenennen und Löschen die vorhandenen Task-Routen (#748). Bis dahin war der
// einzige Weg zu einem Tippfehler: abhaken und neu tippen.
async function handleRenameSubtask(id, currentTitle, container) {
  const title = await promptModal(t('tasks.subtaskRenamePrompt'), currentTitle);
  // Abbruch (null) und "unverändert" gehen beide ohne Request weiter; ein
  // leergeräumtes Feld ist kein gültiger Titel und wird wie Abbruch behandelt.
  if (!title || title.trim() === currentTitle) return;
  try {
    await api.put(`/tasks/${id}`, { title: title.trim() });
    await loadTasks(container);
    refocusAfterRender();
  } catch (err) {
    window.yuvomi.showToast(err.message, 'danger');
  }
}

async function handleDeleteSubtask(id, title, container) {
  // Rückfrage, weil Löschen der einzige Weg ohne Rückweg ist - abhaken lässt
  // sich zurücknehmen, das hier nicht.
  const ok = await confirmModal(t('tasks.subtaskDeleteConfirm', { title }), {
    confirmLabel: t('common.delete'),
    danger: true,
    detail: t('tasks.subtaskDeleteDetail'),
  });
  if (!ok) return;
  try {
    await api.delete(`/tasks/${id}`);
    await loadTasks(container);
    refocusAfterRender();
  } catch (err) {
    window.yuvomi.showToast(err.message, 'danger');
  }
}

// --------------------------------------------------------
// Kanban-Ansicht
// --------------------------------------------------------

// Die Spalten sind der Weg einer Aufgabe. Die letzte ist keine Station dieses
// Wegs, sondern die Ablage daneben (#688) - deshalb steht dort 'archived' und
// nicht ein vierter Status.
const KANBAN_COLS = () => [
  { status: 'open',        label: t('tasks.kanbanOpen'),       colorVar: '--color-text-secondary' },
  { status: 'in_progress', label: t('tasks.kanbanInProgress'), colorVar: '--color-warning'        },
  { status: 'done',        label: t('tasks.kanbanDone'),       colorVar: '--color-success'        },
  { status: 'archived',    label: t('tasks.kanbanArchived'),   colorVar: '--color-text-tertiary'  },
];

/** In welcher Spalte steht die Aufgabe? Die Ablage sticht den Status. */
function kanbanColumnOf(task) {
  return isArchived(task) ? 'archived' : task.status;
}

function kanbanNextStatus(status) {
  if (status === 'open')        return 'in_progress';
  if (status === 'in_progress') return 'done';
  return 'open';
}

/**
 * Eine Aufgabe in eine Spalte bewegen - der einzige Weg, auf dem das Board
 * schreibt (Maus-Drop, Touch-Drop und der Weiterschalt-Knopf).
 *
 * Aus der Ablage zurück heißt: zurückholen, Status unangetastet lassen. Genau
 * das ging vorher nicht, weil die Spalte den Status SETZTE - eine erledigte
 * Aufgabe kam als offene zurück (#688).
 */
async function moveTaskToColumn(before, column) {
  // `before` ist der Stand VOR dem optimistischen Update - der State ist zu
  // diesem Zeitpunkt schon umgeschrieben, und die Entscheidung, ob überhaupt ein
  // Statuswechsel nötig ist, muss sich auf den alten Stand beziehen.
  if (column === 'archived') {
    await setTaskArchived(before.id, true);
    return;
  }
  if (before.archived_at) await setTaskArchived(before.id, false);
  if (before.status !== column) await api.patch(`/tasks/${before.id}/status`, { status: column });
}

/** Optimistisches Spiegelbild von moveTaskToColumn auf dem State-Objekt. */
function applyColumnLocally(task, column) {
  if (column === 'archived') {
    task.archived_at = new Date().toISOString();
    return;
  }
  task.archived_at = null;
  task.status = column;
}

/** Board-Bewegung mit optimistischem Vorgriff - der eine Weg für alle drei Gesten. */
async function runColumnMove(task, column, container) {
  const before = { id: task.id, status: task.status, archived_at: task.archived_at };
  applyColumnLocally(task, column);
  renderKanban(container);
  try {
    await moveTaskToColumn(before, column);
  } catch (err) {
    window.yuvomi.showToast(err.message, 'danger');
  }
  await loadTasks(container);
}

function renderKanbanCard(task) {
  const archived = isArchived(task);
  const due  = formatDueDate(task.due_date, task.due_time, task.status === 'done' || archived);
  // Aus der Ablage führt nur ein Schritt: zurück. Wohin, sagt der Status, den
  // die Aufgabe die ganze Zeit behalten hat.
  const next = archived ? task.status : kanbanNextStatus(task.status);
  const icon = archived ? 'archive-restore'
    : next === 'done' ? 'check' : next === 'in_progress' ? 'circle-play' : 'rotate-ccw';
  const nextLabel = archived
    ? t('tasks.unarchiveButton')
    : next === 'done'
      ? t('tasks.kanbanMoveToDone')
      : next === 'in_progress'
        ? t('tasks.kanbanMoveToInProgress')
        : t('tasks.kanbanMoveToOpen');
  return `
    <!-- KEIN draggable-Attribut, obwohl die Karte ziehbar ist: SortableJS zieht
         ueber seine draggable-OPTION (einen Selektor), und ein echtes
         DOM-draggable aktiviert natives HTML5-DnD, das der Pointer-Geste den Zug
         wegnimmt (gemessen 2026-09-02: kein Ghost, kein Spaltenwechsel, sogar
         der Titel-Klick blieb aus). Fuer Sonde 7 ist die Karte deshalb ueber
         CARD_OBJECT_EXEMPT ausgenommen, nicht ueber das Attribut. -->
    <div class="kanban-card ${task.status === 'done' ? 'kanban-card--done' : ''}"
         data-task-id="${task.id}">
      <!-- Button statt div: einziger Tastaturweg in die Kartendetails; der
           Board-Klick-Handler fängt ihn über die umschließende
           .kanban-card[data-task-id]. -->
      <button type="button" class="kanban-card__title u-card-title u-compact">${esc(task.title)}</button>
      <div class="kanban-card__meta">
        ${renderPriorityBadge(task.priority)}
        ${due ? `<span class="due-date ${due.cls}"><i data-lucide="clock" class="icon-sm" aria-hidden="true"></i> ${due.label}</span>` : ''}
        ${renderTagBadges(task.tags, TAG_BADGES_VISIBLE, task.priority)}
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
  for (const t of filteredTasks()) {
    const column = kanbanColumnOf(t);
    if (grouped[column]) grouped[column].push(t);
    else grouped['open'].push(t);
  }

  const now = new Date();
  for (const col of cols) {
    grouped[col.status].sort((a, b) => sortTasks(a, b, now));
  }

  // Bei aktiver Suche ohne Treffer wäre ein Board aus lauter „Keine Aufgaben"-
  // Spalten irreführend (wirkt wie ein leeres Modul statt wie ein leeres Such-
  // ergebnis). Stattdessen ein board-weiter Treffer-Empty analog zur Liste,
  // inkl. expliziter Zurücksetzen-Affordanz (Critique P3).
  const isFiltered   = state.searchQuery.trim().length > 0;
  const totalVisible = cols.reduce((n, c) => n + grouped[c.status].length, 0);
  if (isFiltered && totalVisible === 0) {
    listEl.replaceChildren();
    listEl.insertAdjacentHTML('beforeend', emptyStateHTML({
      variant: 'no-results',
      title: t('tasks.noResultsTitle'),
      description: t('tasks.noResultsDescription', { query: state.searchQuery }),
      action: {
        label: t('common.searchClear'),
        icon: 'x',
        attrs: { id: 'kanban-reset-search' },
      },
    }));
    if (window.lucide) window.lucide.createIcons({ el: listEl });
    listEl.querySelector('#kanban-reset-search')?.addEventListener('click', () => {
      state.searchQuery = '';
      const input = container.querySelector('#tasks-search');
      if (input) input.value = '';
      container.querySelector('[data-page-search-clear]')?.setAttribute('hidden', '');
      renderTaskList(container);
    });
    return;
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
            ${grouped[col.status].length
              ? grouped[col.status].map((task) => renderKanbanCard(task)).join('')
              : `<div class="kanban-col__empty">
                   <span class="kanban-col__empty-idle">${t('tasks.kanbanColEmpty')}</span>
                   <span class="kanban-col__empty-drop">${t('tasks.kanbanDropHint')}</span>
                 </div>`}
          </div>
        </div>
      `).join('')}
    </div>`;
  listEl.replaceChildren();
  listEl.insertAdjacentHTML('beforeend', kanbanHtml);

  if (window.lucide) window.lucide.createIcons({ el: listEl });
  wireKanbanSortable(container);
  wireKanbanClicks(container);
}

/**
 * Die Karten des Boards, gezogen ueber den projektweiten Sortable-Wrapper.
 *
 * VORHER STANDEN HIER ZWEI IMPLEMENTIERUNGEN: natives HTML5-DnD fuer die Maus
 * und eine eigene Touch-Simulation mit selbstgebautem Ghost-Element daneben.
 * Die Touch-Haelfte war der Grund fuer #808 - sie hatte eine Schwelle, aber die
 * falsche Sorte: acht Pixel Weg und KEINE Zeit. Wer auf dem Telefon ueber einer
 * Karte scrollte, hatte die acht Pixel nach einem Wimpernschlag zusammen, und
 * `preventDefault()` nahm der Geste danach das Scrollen weg. Die Karte fuhr mit.
 *
 * Der Wrapper macht seit jeher genau die Unterscheidung, die der Melder
 * vorgeschlagen hat: `delay: 120` mit `delayOnTouchOnly` - halten greift,
 * Wischen bleibt Scrollen, und die Maus zieht unveraendert sofort.
 *
 * ZWEI DINGE, DIE DIE UMSTELLUNG MITTRAGEN MUSSTE:
 *
 * 1. Der Drop haengt an mehr als der Geste. Zwischen den Spalten liegt ein
 *    Statuswechsel, und die vierte Spalte ist gar kein Status, sondern die
 *    Ablage (#688). Beides entscheidet unveraendert `runColumnMove` - der eine
 *    Weg, den auch der Weiterschalt-Knopf geht. Hier wird nur noch die Spalte
 *    abgelesen.
 * 2. `sort: false`. Das Board speichert KEINE Reihenfolge innerhalb einer
 *    Spalte, und was es nicht speichert, darf es nicht anbieten: eine
 *    umsortierte Karte bliebe sonst an ihrem neuen Platz liegen, bis
 *    irgendetwas anderes neu zeichnet. Zwischen den Spalten bleibt der Zug
 *    erlaubt - genau das ist `sort: false` mit `group`.
 */
let kanbanSortables = [];

function destroyKanbanSortables() {
  kanbanSortables.forEach((inst) => { try { inst.destroy(); } catch { /* schon abgeraeumt */ } });
  kanbanSortables = [];
}

function wireKanbanSortable(container) {
  const board = container.querySelector('.kanban-board');
  if (!board) return;
  // renderKanban() baut die Spalten bei jedem Zug neu. Ohne das Abraeumen
  // haengen die alten Instanzen an Knoten, die es nicht mehr gibt.
  destroyKanbanSortables();

  board.querySelectorAll('[data-drop-zone]').forEach((zone) => {
    makeSortable(zone, {
      // Ohne `draggable` waeren auch der Leerzustands-Hinweis und alles andere
      // im Spaltenkoerper ziehbar.
      draggable: '.kanban-card',
      // DER WEITERSCHALT-KNOPF WIRD NICHT ZUM GRIFF. Der alte Touch-Handler nahm
      // ihn ausdruecklich aus (`e.target.closest('[data-next-status]')`), und
      // beim Umstellen ging genau diese Zeile verloren: ohne Filter kennt
      // SortableJS nur `a` und `img`, also haette ein Druck auf den Knopf, der
      // laenger als 120 ms dauert und dabei fuenf Pixel wandert, die Karte
      // aufgenommen statt sie weiterzuschalten - und sie womoeglich in einer
      // anderen Spalte abgelegt. Der Knopf ist zugleich der Tastaturweg des
      // Boards; er darf am wenigsten von allem zur Drag-Flaeche werden.
      //
      // Der Titel bleibt greifbar: an ihm nimmt man die Karte auf, das war
      // vorher so und ist die einzige grosse Flaeche, die dafuer taugt.
      filter: '[data-next-status]',
      group: 'kanban-board',
      sort: false,
      onEnd: (evt) => {
        const column = evt.to?.dataset.dropZone;
        const task = state.tasks.find((t) => String(t.id) === String(evt.item?.dataset.taskId));
        if (!column || !task || kanbanColumnOf(task) === column) return;
        runColumnMove(task, column, container);
      },
    }).then((inst) => { if (inst) kanbanSortables.push(inst); })
      .catch(() => { /* ohne SortableJS bleibt der Weiterschalt-Knopf jeder Karte */ });
  });
}

/**
 * Die Klicks des Boards: Weiterschalten und Kartendetails.
 *
 * Sie standen bis #808 im Drag-Verdrahter, weil beides am selben Board hing.
 * Der Test auf eine Karte lief ueber `[draggable]` - ein Attribut, das der
 * Wrapper nicht mehr setzt. Ein Selektor, der die Karte an ihrer Ziehbarkeit
 * erkennt, haette die Details beim Umstellen lautlos verschlossen.
 */
function wireKanbanClicks(container) {
  const board = container.querySelector('.kanban-board');
  if (!board) return;

  board.addEventListener('click', async (e) => {
    const statusBtn = e.target.closest('[data-next-status]');
    if (statusBtn) {
      e.stopPropagation();
      const card = statusBtn.closest('.kanban-card[data-task-id]');
      if (!card) return;
      const task = state.tasks.find((t) => String(t.id) === String(card.dataset.taskId));
      if (!task) return;
      // Der Knopf einer abgelegten Karte holt zurueck, statt weiterzuschalten -
      // sein data-next-status traegt dann den Status, den die Aufgabe behalten hat.
      await runColumnMove(task, statusBtn.dataset.nextStatus, container);
      return;
    }

    const card = e.target.closest('.kanban-card[data-task-id]');
    if (!card) return;
    try {
      const [task, reminder] = await Promise.all([
        loadTaskForEdit(card.dataset.taskId),
        loadReminderForTask(card.dataset.taskId),
      ]);
      openTaskView(task, reminder, container);
    } catch (err) {
      window.yuvomi.showToast(t('tasks.loadError'), 'danger');
    }
  });
}

// --------------------------------------------------------
// Verlauf (#791)
//
// Die dritte Ansicht neben Liste und Board, und die einzige, die keine Aufgaben
// zeigt, sondern Vorgänge: wer wann was abgehakt hat. Sie hängt an demselben
// `#task-list` wie die beiden anderen - eine zweite Fläche daneben hieße, dass
// jede Änderung am Seitenlayout an zwei Stellen nachgezogen werden muss.
//
// SIE BEGINNT LEER. Aufgezeichnet wird seit der Migration, und was davor
// abgehakt wurde, hat niemand aufgeschrieben. Der Leerzustand sagt das, statt
// „nichts erledigt" zu behaupten - das wäre für einen Haushalt, der seit Monaten
// Aufgaben abhakt, schlicht gelogen.
// --------------------------------------------------------

/**
 * Einträge nach dem Kalendertag der Anzeigezone bündeln.
 *
 * Über `zonedDateKey` und nicht über `completed_at.slice(0, 10)`: der
 * gespeicherte Zeitpunkt ist UTC, und ein Haken um 23:30 Ortszeit landete damit
 * westlich von UTC unter dem Tag danach - dieselbe Falle, gegen die
 * `toLocalDateKey()` in der ganzen App steht.
 */
function groupHistoryByDay(entries) {
  const groups = [];
  const index = new Map();
  for (const entry of entries) {
    const day = zonedDateKey(entry.completed_at);
    if (!index.has(day)) {
      index.set(day, { day, entries: [] });
      groups.push(index.get(day));
    }
    index.get(day).entries.push(entry);
  }
  return groups;
}

/**
 * Ein Vorgang: wer, was, wann.
 *
 * Auf der geteilten Zeilen-Grammatik (styles/list-row.css) und mit demselben
 * Avatar wie ueberall sonst - `renderAvatarStack` traegt schon die Frage, ob
 * Bild oder Initialen, und welche Textfarbe auf dieser Nutzerfarbe lesbar ist.
 * Ein eigener Avatar hier haette dieselbe Kontrastrechnung ein zweites Mal
 * anstellen muessen, und die erste hat sie beim Avatar der Mitglieder bereits
 * einmal falsch gehabt.
 */
function renderHistoryEntry(entry) {
  const name = entry.user_name || t('tasks.historyUnknownMember');
  const avatar = renderAvatarStack(
    [{ display_name: name, color: entry.user_color, avatar_data: entry.user_avatar }],
    { size: 32, maxVisible: 1 },
  );
  // Der Avatar traegt hier NICHTS bei, was nicht daneben stuende: der Name
  // steht als Text in der Metazeile. Ohne aria-hidden liest die Sprachausgabe
  // „AJ ... Alex Johnson" - derselbe Mensch zweimal, einmal als Kuerzel.
  return `
    <button type="button" class="list-row history-row" data-history-task="${entry.task_id}">
      <span class="history-row__avatar" aria-hidden="true">${avatar}</span>
      <span class="list-row__main history-row__main">
        <span class="list-row__name">${esc(entry.title)}</span>
        <span class="list-row__meta">
          ${esc(name)}${entry.is_recurring
            ? ` <i data-lucide="repeat" class="icon-sm" aria-hidden="true"></i>` : ''}
        </span>
      </span>
      <time class="history-row__time" datetime="${esc(entry.completed_at)}">${esc(formatTime(entry.completed_at))}</time>
    </button>`;
}

/** Die Personenauswahl - „Alle" plus je ein Mitglied.
 *
 * JEDER CHIP BRAUCHT ETWAS, DAS BLEIBT, WENN SEIN LABEL FAELLT (#1068).
 *
 * Unter 640px entfernt die Label-Verlust-Regel (tasks.css) jedes
 * `.group-toggle__label`. Sie ist dafuer gebaut, dass ein Icon zurueckbleibt -
 * beim Ansichts-Umschalter daneben steht es schon immer neben dem Text. Diese
 * Chips hatten keins, also blieb der Knopf LEER: eine Reihe namenloser Flaechen,
 * bei der nur die getoente Flaeche verriet, welche gerade gewaehlt ist.
 *
 * Und der Verlust war nicht nur ein sichtbarer. `display: none` nimmt den Text
 * auch aus dem Accessibility-Tree; ohne eigenen Namen am Knopf war der Filter
 * auf dem Telefon fuer eine Vorlesehilfe ebenso namenlos wie fuers Auge. Der
 * Name gehoert deshalb an den KNOPF (`aria-label`), nicht in ein Kind, das eine
 * Media-Query wegnehmen darf.
 *
 * Was bleibt: fuer die Mitglieder ihr Avatar - dieselbe Scheibe, die die
 * Verlaufszeilen darunter schon tragen, also kein neues Zeichen, sondern ein
 * bekanntes. `renderAvatarStack` bringt Bild oder Initialen samt
 * Kontrastrechnung mit; sie hier ein zweites Mal zu bauen war schon einmal
 * falsch (siehe renderHistoryEntry). Fuer „Alle" ein Icon aus derselben
 * Familie wie die Umschalter daneben. */
function renderHistoryPeople() {
  const chip = (id, label, mark) => {
    const on = state.history.userId === id;
    return `<button type="button" class="group-toggle__btn${on ? ' group-toggle__btn--active' : ''}"
            data-history-user="${id === null ? '' : id}" aria-pressed="${on}"
            title="${esc(label)}" aria-label="${esc(label)}">
      ${mark}
      <span class="group-toggle__label">${esc(label)}</span>
    </button>`;
  };
  /* Die Marke ist Schmuck fuer die Vorlesehilfe: den Namen traegt der Knopf.
   * Ohne `aria-hidden` kaeme er zweimal - einmal als `aria-label`, einmal aus
   * dem `alt` des Avatarbildes.
   *
   * ZWEI RENDERER, ZWEI FELDNAMEN FUER DIESELBE FARBE. `state.users` kommt aus
   * `/tasks/meta/options` und heisst dort `avatar_color`, so wie es in der
   * Tabelle steht; `renderAvatarStack` liest `color`, weil es sonst aus
   * `ASSIGNED_USERS_SQL` gefuettert wird, das genau dafuer umbenennt
   * (`'color', u.avatar_color`). Beide Seiten sind fuer sich richtig - wer sie
   * ungefiltert zusammensteckt, bekommt lautlos die Fallback-Farbe fuer JEDEN,
   * und damit sind zwei Mitglieder mit gleichen Initialen auf dem Telefon nicht
   * mehr zu unterscheiden. Deshalb hier die Uebersetzung.
   *
   * Ein Foto traegt `/meta/options` nicht, also bleiben es Initialen auf der
   * Nutzerfarbe. Das ist kein Verlust gegenueber dem Nachbarn: `renderUserMulti
   * Select` wird aus derselben Liste bedient und zeigt aus demselben Grund
   * ebenfalls keins. Die Farbe ist ohnehin das Identitaetssignal (User-Farben-
   * Regel), das Bild die Zugabe. */
  const personMark = (u) => `<span class="history-people__mark" aria-hidden="true">${
    renderAvatarStack([{ ...u, color: u.avatar_color }], { size: 22, maxVisible: 1 })}</span>`;
  // Nur wer wirklich etwas beisteuern kann: die Housekeeping-Konten sind aus
  // /meta/options schon heraus, und ein Haushalt aus einer Person braucht die
  // Auswahl gar nicht.
  if (isSoloHousehold()) return '';
  return `
    <div class="group-toggle history-people" role="group" aria-label="${t('tasks.historyPersonFilter')}">
      ${chip(null, t('common.all'),
        '<i data-lucide="users" class="icon-md group-toggle__icon" aria-hidden="true"></i>')}
      ${state.users.map((u) => chip(u.id, u.display_name, personMark(u))).join('')}
    </div>`;
}

/** Die Personen-Chips verdrahten - beide Zweige von renderHistory zeigen sie. */
function wireHistoryPeople(root, container) {
  root.querySelectorAll('[data-history-user]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const raw = btn.dataset.historyUser;
      state.history.userId = raw === '' ? null : Number(raw);
      loadHistory(container);
    });
  });
}

function renderHistory(container) {
  const listEl = container.querySelector('#task-list');
  if (!listEl) return;

  if (state.history.error) {
    // Die Personenauswahl bleibt STEHEN. Ohne sie war ein Fehler unter einem
    // aktiven Personenfilter eine Sackgasse: „Erneut versuchen" schickte
    // dieselbe scheiternde Abfrage los, und es gab kein „Alle", auf das man
    // haette ausweichen koennen.
    listEl.replaceChildren();
    listEl.insertAdjacentHTML('beforeend', renderHistoryPeople());
    const errorBox = document.createElement('div');
    listEl.appendChild(errorBox);
    mountLoadError(errorBox, {
      title: t('tasks.historyLoadError'),
      description: t('common.loadErrorDescription'),
      error: state.history.error,
      retryLabel: t('common.retry'),
      onRetry: () => loadHistory(container),
    });
    wireHistoryPeople(listEl, container);
    if (window.lucide) window.lucide.createIcons({ el: listEl });
    return;
  }

  const { entries, hasMore } = state.history;
  const body = entries.length
    ? groupHistoryByDay(entries).map(({ day, entries: dayEntries }) => `
        <div class="task-group list-group">
          <h2 class="list-group__title">
            <span>${esc(historyDayLabel(day))}</span>
            <span class="list-group__count">${dayEntries.length}</span>
          </h2>
          <div class="list-rows">${dayEntries.map(renderHistoryEntry).join('')}</div>
        </div>`).join('')
    // Ein Leerzustand ohne Anlegen-Knopf: „erledige etwas" ist keine Handlung,
    // die dieser Bildschirm anbieten kann, und der Hinweis erklärt stattdessen,
    // warum hier auch in einem gut geführten Haushalt nichts stehen kann.
    : emptyStateHTML({
      icon: 'history',
      title: state.history.userId === null ? t('tasks.historyEmptyTitle') : t('tasks.historyEmptyPersonTitle'),
      description: t('tasks.historyEmptyDescription'),
      // Der Hinweis erklaert, warum der Verlauf des HAUSHALTS leer sein kann,
      // obwohl seit Monaten abgehakt wird. Unter einem Personenfilter erklaert
      // er die falsche Sache: dort ist die Antwort schlicht, dass diese Person
      // nichts abgehakt hat.
      hint: state.history.userId === null ? t('tasks.historyEmptyHint') : undefined,
    });

  listEl.replaceChildren();
  listEl.insertAdjacentHTML('beforeend', `
    ${renderHistoryPeople()}
    ${body}
    ${hasMore ? `<div class="history-more">
      <button type="button" class="btn btn--secondary" id="history-more">${t('tasks.historyLoadMore')}</button>
    </div>` : ''}
  `);
  if (window.lucide) window.lucide.createIcons({ el: listEl });
  stagger(listEl.querySelectorAll('.history-row'));

  wireHistoryPeople(listEl, container);
  listEl.querySelector('#history-more')?.addEventListener('click', (e) => {
    // Kein Zuruecksetzen noetig und keins moeglich: `loadHistory` faengt seinen
    // Fehler selbst ab und wirft nie, und danach baut `renderHistory` die
    // Flaeche samt diesem Knopf neu auf - der Spinner geht mit ihm.
    btnLoading(e.currentTarget);
    loadHistory(container, { append: true });
  });
  listEl.querySelectorAll('[data-history-task]').forEach((row) => {
    row.addEventListener('click', () => openTaskFromHistory(row.dataset.historyTask, container));
  });
}

/** Ein Verlaufseintrag führt zu seiner Aufgabe - der einzige Weg von hier weg. */
async function openTaskFromHistory(id, container) {
  try {
    const [task, reminder] = await Promise.all([loadTaskForEdit(id), loadReminderForTask(id)]);
    openTaskView(task, reminder, container);
  } catch (err) {
    window.yuvomi.showToast(err.message ?? t('common.errorGeneric'), 'danger');
  }
}

/**
 * Verlauf laden. `append` hängt die nächste Seite an, alles andere fängt vorn
 * an - ein Personenwechsel darf keine Mischung aus zwei Abfragen stehen lassen.
 */
async function loadHistory(container, { append = false } = {}) {
  // Ein zweiter Aufruf, waehrend einer laeuft, WARTET auf den ersten und faehrt
  // dann selbst - er wird nicht verworfen. Ein blosses `return` hier hatte den
  // Klick auf ein Personen-Chip stillschweigend geschluckt: `userId` war schon
  // umgestellt, geladen wurde nichts, und ohne ein abschliessendes Zeichnen
  // blieb die alte Liste unter dem neu markierten Chip stehen.
  while (state.history.loading) {
    // eslint-disable-next-line no-await-in-loop
    await state.history.loading;
  }
  let release;
  state.history.loading = new Promise((r) => { release = r; });
  const params = new URLSearchParams({ limit: '50' });
  if (state.history.userId !== null) params.set('user_id', String(state.history.userId));
  if (append && state.history.cursor) {
    params.set('before_at', state.history.cursor.before_at);
    params.set('before_id', String(state.history.cursor.before_id));
  }
  try {
    const res = await api.get(`/tasks/completions?${params}`);
    state.history.entries = append ? [...state.history.entries, ...(res.data ?? [])] : (res.data ?? []);
    state.history.hasMore = !!res.has_more;
    state.history.cursor = res.next_cursor ?? null;
    state.history.error = null;
  } catch (err) {
    console.error('[Tasks] Verlauf-Ladefehler:', err.message);
    state.history.error = err;
    if (!append) { state.history.entries = []; state.history.hasMore = false; state.history.cursor = null; }
  } finally {
    state.history.loading = null;
    release();
    renderHistory(container);
  }
}

// --------------------------------------------------------
// Partielle DOM-Updates
// --------------------------------------------------------

function renderTaskList(container) {
  // VOR dem Ladefehler der Aufgaben: der Verlauf hat seinen eigenen Bestand und
  // seinen eigenen Fehler. Ein gescheitertes `/tasks` sagt nichts darüber, ob
  // die Vorgänge zu haben sind - stünde die Weiche danach, zeigte der Verlauf
  // den Fehler einer Abfrage, die er gar nicht braucht.
  if (state.viewMode === 'history') {
    // NEU LADEN, nicht den zwischengespeicherten Bestand neu malen. Jeder
    // schreibende Weg endet auf `loadTasks() -> renderTaskList()`, und genau
    // dort aendert sich der Verlauf mit: ein wieder geoeffneter Haken loescht
    // seinen Eintrag serverseitig. Ohne das Nachladen blieb die zurueckgenommene
    // Erledigung stehen, bis jemand die Ansicht verliess.
    loadHistory(container);
    return;
  }
  // VOR der Kanban-Weiche: nach einem Ladefehler ist `state.tasks` ebenfalls
  // leer, und beide Ansichten haengen an demselben `#task-list`. Nur die
  // Reihenfolge trennt hier „nichts angelegt" von „nicht geladen".
  if (state.loadError) {
    const listEl = container.querySelector('#task-list');
    if (listEl) {
      mountLoadError(listEl, {
        title: t('tasks.listLoadError'),
        description: t('common.loadErrorDescription'),
        error: state.loadError,
        retryLabel: t('common.retry'),
        onRetry: () => render(container, { user: state.user }),
      });
    }
    return;
  }
  if (state.viewMode === 'kanban') {
    renderKanban(container);
    return;
  }
  const listEl = container.querySelector('#task-list');
  if (!listEl) return;
  listEl.replaceChildren();
  listEl.insertAdjacentHTML('beforeend', renderTaskGroups(filteredTasks(), state.groupMode));
  if (window.lucide) window.lucide.createIcons({ el: listEl });
  stagger(listEl.querySelectorAll('.swipe-row, .kanban-card'));
  updateBulkActionsBar(container);
  wireSwipeGestures(container);
  maybeShowSwipeHint(container);
  listEl.querySelector('#empty-cta-tasks')?.addEventListener('click', () => {
    document.querySelector('.page-fab')?.click();
  });
}

function makeRemoveSpan() {
  const rm = document.createElement('span');
  rm.className = 'filter-chip__remove';
  rm.setAttribute('aria-hidden', 'true');
  const icon = document.createElement('i');
  icon.setAttribute('data-lucide', 'x');
  icon.className = 'icon-sm';
  rm.appendChild(icon);
  return rm;
}

/**
 * Ein Filter-Chip. Immer ein <button> — die Chips schalten Filter, sind also
 * Bedienelemente und müssen fokussierbar sein und ihren Zustand melden.
 * Dokumente und Kontakte rendern dieselbe .filter-chip-Klasse ebenfalls als
 * Button mit aria-pressed; hier lag zuvor ein <span> ohne Tastaturzugang.
 *
 * pressed === null markiert Aktions-Chips (zuletzt verwendete Filter), die
 * keinen Ein/Aus-Zustand haben und daher kein aria-pressed tragen dürfen.
 */
function makeChip({ label, active = false, extraClass = '', pressed = undefined, withRemove = false }) {
  const chip = document.createElement('button');
  chip.type = 'button';
  chip.className = `filter-chip${active ? ' filter-chip--active' : ''}${extraClass ? ` ${extraClass}` : ''}`;
  if (pressed !== null) chip.setAttribute('aria-pressed', String(pressed ?? active));
  // Das Entfernen-X ist aria-hidden (Dekor im selben Button); die Entfernen-
  // Aktion muss deshalb in den Accessible Name des Chips selbst.
  if (withRemove && label != null) {
    chip.setAttribute('aria-label', t('tasks.removeFilter', { label }));
  }
  if (label != null) chip.appendChild(document.createTextNode(label));
  if (withRemove) chip.appendChild(makeRemoveSpan());
  return chip;
}

function renderFilters(container) {
  const bar   = container.querySelector('#filter-bar');
  const panel = container.querySelector('#filter-panel');
  if (!bar || !panel) return;

  const statusLabels   = STATUS_LABELS();
  const priorityLabels = PRIORITY_LABELS();
  // Im Kanban ist der Statusfilter unwirksam (die Spalten SIND der Status) und
  // wird nicht als Chip gezeigt - daher auch nicht mitzählen, sonst behauptet
  // "Filter N" einen unsichtbaren Filter (Audit P3).
  const activeCount    = (state.viewMode === 'kanban' ? 0 : state.filters.status.length)
    + state.filters.priority.length
    + state.filters.assigned_to.length
    + state.filters.category.length
    + state.filters.tags.length;

  // ---- Chip-Leiste: nur aktive Filter + Toggle-Button ----
  bar.replaceChildren();

  // Ein Chip je gewähltem Wert, in jeder Achse. Jeder trägt seinen eigenen
  // Wert, damit das Entfernen genau diesen einen löst und nicht die ganze
  // Auswahl (#671) - vorher gab es je Achse nur einen Wert und damit einen Chip.
  if (state.viewMode !== 'kanban') {
    state.filters.status.forEach((value) => {
      const chip = makeChip({ label: statusLabels[value] ?? value, active: true, withRemove: true });
      chip.dataset.filter = 'status';
      chip.dataset.value = value;
      bar.appendChild(chip);
    });
  }
  state.filters.priority.forEach((value) => {
    const chip = makeChip({ label: priorityLabels[value] ?? value, active: true, withRemove: true });
    chip.dataset.filter = 'priority';
    chip.dataset.value = value;
    bar.appendChild(chip);
  });
  // Aktive Personen-Filter — außer der eigenen ID, die deckt der dedizierte
  // „Mir zugewiesen"-Chip ab (keine Doppel-Anzeige).
  state.filters.assigned_to.forEach((value) => {
    if (state.currentUserId != null && Number(value) === Number(state.currentUserId)) return;
    const u = state.users.find((user) => user.id === Number(value));
    const chip = makeChip({
      label: u?.display_name ?? t('tasks.filterGroupPerson'),
      active: true,
      withRemove: true,
    });
    chip.dataset.filter = 'assigned_to';
    chip.dataset.value = value;
    bar.appendChild(chip);
  });
  // Ein Chip je gewähltem Tag. Jeder trägt seinen eigenen Wert, damit das
  // Entfernen genau diesen einen löst und nicht die ganze Auswahl.
  state.filters.category.forEach((value) => {
    const chip = makeChip({ label: catLabel(value), active: true, withRemove: true });
    chip.dataset.filter = 'category';
    chip.dataset.value = value;
    bar.appendChild(chip);
  });
  state.filters.tags.forEach((tag) => {
    const chip = makeChip({ label: tag, active: true, withRemove: true });
    chip.dataset.filter = 'tag';
    chip.dataset.value = tag;
    bar.appendChild(chip);
  });

  // "Mir zugewiesen" Schnellzugriff — nur sinnvoll bei mehreren Familienmitgliedern.
  // Icon+Label bewusst identisch zum Kalender-Toggle (gleiche Fähigkeit, eine Gestalt).
  if (state.users.length > 1 && state.currentUserId != null) {
    const meActive = isAssignedToMe();
    const meChip = makeChip({ label: null, active: meActive, extraClass: 'filter-chip--toggle' });
    meChip.id = 'filter-assigned-me';
    const meIcon = document.createElement('i');
    meIcon.setAttribute('data-lucide', 'user');
    meIcon.className = 'icon-sm';
    meIcon.setAttribute('aria-hidden', 'true');
    const meLabel = document.createElement('span');
    meLabel.textContent = t('tasks.assignedToMe');
    meChip.append(meIcon, meLabel);
    if (meActive) meChip.appendChild(makeRemoveSpan());
    bar.appendChild(meChip);
  }

  // "Geplante anzeigen" Toggle-Chip — Icon+Label wie „Mir zugewiesen" (beide Toggles).
  const futureChip = makeChip({ label: null, active: state.showFuture, extraClass: 'filter-chip--toggle' });
  futureChip.id = 'filter-show-future';
  const futureIcon = document.createElement('i');
  futureIcon.setAttribute('data-lucide', 'calendar-clock');
  futureIcon.className = 'icon-sm';
  futureIcon.setAttribute('aria-hidden', 'true');
  const futureLabel = document.createElement('span');
  futureLabel.textContent = t('tasks.showFuture');
  futureChip.append(futureIcon, futureLabel);
  if (state.showFuture) {
    futureChip.appendChild(makeRemoveSpan());
  }
  bar.appendChild(futureChip);

  const toggleBtn = document.createElement('button');
  toggleBtn.id = 'filter-toggle-btn';
  // `filter-chip` trägt die Form, `filter-toggle-btn` nur noch die Abweichung:
  // der Knopf stand mit einer eigenen, zeichengleichen Kopie derselben vierzehn
  // Deklarationen daneben (siehe tasks.css) und war damit der vierte Chip, den
  // die geteilte Datei eigentlich abgelöst hat.
  toggleBtn.className = `filter-chip filter-toggle-btn${state.filterPanelOpen ? ' filter-toggle-btn--open' : ''}${activeCount > 0 ? ' filter-toggle-btn--active' : ''}`;
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
    // Jeder Wert jeder Achse wird benannt: seit #671 kann ein gemerktes Set
    // "Hoch" UND "Mittel" enthalten, und ein Chip, der nur den ersten nennt,
    // schaltete beim Klick mehr, als er behauptet.
    f.status.forEach((v) => parts.push(statusLabelsMap[v] ?? v));
    f.priority.forEach((v) => parts.push(priorityLabelsMap[v] ?? v));
    f.assigned_to.forEach((v) => {
      const u = state.users.find((user) => user.id === Number(v));
      if (u) parts.push(u.display_name);
    });
    f.category.forEach((v) => parts.push(catLabel(v)));
    // Die Tags gehören in die Beschriftung, weil der Chip sie beim Klick
    // mitsetzt: ohne sie hieße ein Chip „Offen" und schaltete zusätzlich
    // Tag-Filter, die niemand am Chip ablesen kann (#586).
    parts.push(...f.tags);
    if (!parts.length) return;
    // Aktions-Chip (wendet ein Filter-Set an), kein Ein/Aus-Zustand → pressed:null.
    const chip = makeChip({ label: parts.join(' · '), extraClass: 'filter-chip--recent', pressed: null });
    chip.dataset.recentFilter = JSON.stringify(f);
    bar.appendChild(chip);
  });

  if (window.lucide) window.lucide.createIcons({ el: bar });

  // ---- Filter-Panel: Gruppen mit allen Optionen ----
  panel.hidden = !state.filterPanelOpen;
  panel.replaceChildren();

  if (state.filterPanelOpen) {
    // Im Kanban entfällt die Status-Gruppe: die Spalten übernehmen diese
    // Achse bereits (Audit A1-07).
    const groups = [
      ...(state.viewMode !== 'kanban' ? [{
        key: 'status',
        label: t('tasks.filterGroupStatus'),
        items: FILTER_STATUSES().map((s) => ({ value: s.value, label: s.label })),
      }] : []),
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
    // Kategorie in beiden Ansichten: die Liste kann danach gruppieren, das
    // Board nicht, weil seine Spalten schon der Status sind (D#1017). Die
    // Beschriftung ist dieselbe wie im Formular, nicht ein fuenfter Wortlaut.
    if (state.categories.length) {
      groups.push({
        key: 'category',
        label: t('tasks.categoryLabel'),
        items: state.categories.map((c) => ({ value: c.key, label: catLabel(c.key) })),
      });
    }
    // Tags nur anbieten, wenn welche vergeben sind — ohne CalDAV-Spiegel und ohne
    // eigene Vergabe bleibt die Gruppe sonst als leere Zeile stehen (#586).
    if (state.allTags.length) {
      groups.push({
        key: 'tag',
        label: t('tasks.filterGroupTag'),
        items: state.allTags.map((entry) => ({ value: entry.tag, label: entry.tag })),
      });
    }

    groups.forEach((group) => {
      const section = document.createElement('div');
      section.className = 'filter-panel__group';
      section.setAttribute('role', 'group');
      section.setAttribute('aria-label', group.label);

      const heading = document.createElement('div');
      heading.className = 'filter-panel__label';
      heading.textContent = group.label;
      section.appendChild(heading);

      const row = document.createElement('div');
      row.className = 'filter-panel__chips';

      group.items.forEach((item) => {
        // Jede Gruppe erlaubt Mehrfachauswahl (#671); die Tags unterscheiden
        // sich nur darin, dass ihre Zugehörigkeit die Schreibweise ignoriert.
        const isActive = group.key === 'tag'
          ? hasTagFilter(item.value)
          : hasFilter(group.key, item.value);
        const chip = makeChip({ label: item.label, active: isActive, withRemove: isActive });
        chip.dataset.filter = group.key;
        chip.dataset.value = item.value;
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
    if (window.lucide) window.lucide.createIcons({ el: panel });
  }

  wireFilterChips(container);
}

/* DIESES MODUL FUEHRT DIE ZAHL NICHT MEHR (#868).
 *
 * Das Badge beantwortet „wie viele Aufgaben im Haushalt sind ueberfaellig".
 * `state.tasks` beantwortet eine andere Frage: es ist die GEFILTERTE Liste
 * dieser Ansicht. Der Standardfilter zeigt nur `open` (schliesst also
 * „In Bearbeitung" aus), das Kanban laesst den Statusfilter ganz weg, und
 * Priorität, Zuweisung und Tags engen zusaetzlich ein. Aus dieser Liste
 * gezaehlt sprang die Zahl beim blossen Wechsel zwischen Liste und Kanban -
 * ohne dass sich an den Daten etwas geaendert haette. Dieselbe Zahl stand
 * ausserdem in zwei ZONEN: der Server rechnet in der Haushaltszone, eine
 * Client-Rechnung im Automatikmodus in der des Browsers.
 *
 * Der Server zaehlt also, und dass sich etwas geaendert hat, meldet nicht
 * dieses Modul, sondern die API-Schicht (`notifyCountedMutation` in api.js) -
 * eine Stelle statt siebzehn Schreibpfaden allein hier. Es gibt deshalb keine
 * `updateOverdueBadge()` mehr; sie hing am RENDERN und feuerte bei jedem
 * Tastenanschlag in der Suche. */

// --------------------------------------------------------
// Swipe-Gesten (Mobil: links = erledigt, rechts = bearbeiten)
// --------------------------------------------------------

const RECENT_FILTERS_KEY = 'yuvomi:recentTaskFilters';
const RECENT_FILTERS_MAX = 3;
const COLLAPSED_GROUPS_KEY = 'yuvomi:taskCollapsedGroups';
const SHOW_FUTURE_KEY = 'yuvomi:taskShowFuture';
const ASSIGNED_TO_ME_KEY = 'yuvomi:taskAssignedToMe';

// „Mir zugewiesen" ist ein Schnellzugriff auf den assigned_to-Filter mit der
// eigenen User-ID. Wird pro Gerät gemerkt und beim Laden aus dem gespeicherten
// assigned_to-Wert (== eigene ID) abgeleitet, damit Panel-Auswahl und Chip synchron bleiben.
function isAssignedToMe() {
  return state.currentUserId != null && hasFilter('assigned_to', state.currentUserId);
}

function persistAssignedToMe() {
  try { localStorage.setItem(ASSIGNED_TO_ME_KEY, isAssignedToMe() ? '1' : '0'); } catch {}
}

/** Ist dieser Tag gerade gefiltert? Schreibweise zählt dabei nicht. */
function hasTagFilter(tag) {
  const key = String(tag).toLowerCase();
  return state.filters.tags.some((active) => active.toLowerCase() === key);
}

/**
 * Tag im Filter an- oder abwählen. Mehrere Tags engen UND-verknüpft ein, also
 * fügt ein Klick hinzu statt zu ersetzen.
 */
async function toggleTagFilter(tag, container) {
  const key = String(tag).toLowerCase();
  state.filters.tags = hasTagFilter(tag)
    ? state.filters.tags.filter((active) => active.toLowerCase() !== key)
    : [...state.filters.tags, tag];
  if (state.filters.tags.length) saveRecentFilter(state.filters);
  renderFilters(container);
  await loadTasks(container);
}

/**
 * Ein gespeichertes Filter-Set auf die aktuelle Form bringen.
 *
 * Einzelne Strings stammen aus Einträgen, die vor der jeweiligen Mehrfachauswahl
 * im localStorage gelandet sind - `tag` vor der Tag-Auswahl, `status`,
 * `priority` und `assigned_to` vor #671. Ohne die Umschreibung wären das dort
 * keine Arrays, und der erste `.includes` darauf risse die Seite auf, für Werte,
 * die niemand mehr absichtlich gesetzt hat.
 */
function normalizeFilterSet(f = {}) {
  const asList = (value) => (Array.isArray(value) ? value : (value ? [value] : [])).filter(Boolean).map(String);
  return {
    status:      asList(f.status),
    priority:    asList(f.priority),
    assigned_to: asList(f.assigned_to),
    category:    asList(f.category),
    tags:        asList(Array.isArray(f.tags) ? f.tags : (f.tag ? [f.tag] : [])),
  };
}

/** Ist dieser Wert in der Achse gerade gewählt? */
function hasFilter(key, value) {
  return (state.filters[key] || []).includes(String(value));
}

/**
 * Wert einer ODER-Achse an- oder abwählen. Ein Klick ergänzt, statt zu
 * ersetzen - sonst bliebe es bei einem Wert pro Reihe (#671).
 */
async function toggleValueFilter(key, value, container) {
  const current = state.filters[key] || [];
  const next = String(value);
  state.filters[key] = current.includes(next)
    ? current.filter((v) => v !== next)
    : [...current, next];
  if (state.filters[key].length) saveRecentFilter(state.filters);
  renderFilters(container);
  await loadTasks(container);
}

/**
 * Die gemerkten Sets, wie sie im Speicher STEHEN - ohne Veraltungsfilter.
 *
 * Getrennt von `getRecentFilters()`, weil `saveRecentFilter()` sonst die
 * gefilterte Fassung zurueckschriebe: das waere Bereinigen beim Schreiben durch
 * die Hintertuer, und ein einmal unvollstaendiger Referenzbestand (Ladefehler,
 * noch nicht geladene Tags) haette die Chips fuer immer entfernt.
 */
function storedRecentFilters() {
  try {
    return JSON.parse(localStorage.getItem(RECENT_FILTERS_KEY) ?? '[]').map(normalizeFilterSet);
  } catch { return []; }
}

/**
 * Die gemerkten Sets, wie sie ANGEBOTEN werden duerfen.
 *
 * Was ein Set nennt, kann verschwinden, nachdem es gespeichert wurde: eine
 * geloeschte Kategorie, ein umbenannter oder zusammengefuehrter Tag, ein
 * entferntes Haushaltsmitglied. Bliebe der Wert im Chip, brachte ein Klick ihn
 * in `state.filters` zurueck, die Liste filterte auf etwas, das es nicht mehr
 * gibt - dauerhaft leer, und ein Neuladen aenderte nichts, weil der Wert im
 * localStorage steht.
 *
 * Lesend statt beim Schreiben (#984, read-side transformation): so gilt die
 * Regel an EINER Stelle und stimmt nach jeder Auffrischung von selbst, auch
 * wenn die Aenderung in einem anderen Tab oder auf einem anderen Geraet
 * passiert ist. Der Speicher bleibt unangetastet - eine wieder angelegte
 * Kategorie bringt ihr Chip mit.
 *
 * Status und Prioritaet stehen bewusst nicht drin: das sind feste Konstanten
 * dieser Datei, sie koennen nicht veralten.
 */
function getRecentFilters() {
  const sets = storedRecentFilters();
  // Nach einem Ladefehler stehen `users`, `categories` und `allTags` auf `[]`
  // (siehe den catch-Zweig in render()). „Leer" hiesse dann „gibt es nicht",
  // und ein Serverfehler naehme dem Nutzer seine gemerkten Filter weg - genau
  // die Verwechslung aus dem Leer-Zweig, die der Ladefehler-Zustand behebt.
  //
  // Und ebenso wenig gegen Referenzlisten, die nicht nachweislich frisch sind -
  // aus dem Offline-Cache oder von einer fehlgeschlagenen Auffrischung: die
  // koennen beliebig alt sein. Vor dem Cache-Zeitpunkt angelegte Werte fehlten dort und
  // versteckten ein gueltiges Chip; danach geloeschte staenden noch drin und
  // boeten weiter einen toten an. Offline gilt dasselbe wie beim Ladefehler -
  // nichts wegnehmen, was jemand gespeichert hat.
  if (state.loadError) return sets;

  // JE ACHSE: eine Liste, die gerade nicht nachweislich frisch ist, beschneidet
  // nicht - die beiden anderen schon. `null` heisst hier „kein Urteil".
  const stale = state.metaStale;
  const knownCategories = stale.categories ? null : new Set(state.categories.map((c) => c.key));
  const knownTags       = stale.tags       ? null : new Set(state.allTags.map((entry) => entry.tag.toLowerCase()));
  const knownUsers      = stale.users      ? null : new Set(state.users.map((u) => String(u.id)));

  const beschnitten = sets
    .map((f) => ({
      ...f,
      assigned_to: knownUsers ? f.assigned_to.filter((id) => knownUsers.has(String(id))) : f.assigned_to,
      category:    knownCategories ? f.category.filter((key) => knownCategories.has(key)) : f.category,
      // Tag-Vergleich kleingeschrieben, wie ueberall sonst in dieser Datei
      // (`hasTagFilter`): der Server behaelt die Schreibweise des Anlegens.
      tags:        knownTags ? f.tags.filter((tag) => knownTags.has(String(tag).toLowerCase())) : f.tags,
    }))
    // Ein Set, von dem nichts uebrig bleibt, ist kein Chip mehr. Es bliebe
    // sonst als leere Pille stehen und setzte beim Klick alle Filter zurueck.
    .filter((f) => f.status.length || f.priority.length || f.assigned_to.length
      || f.category.length || f.tags.length);

  // Und was nach dem Beschneiden gleich AUSSIEHT, ist auch gleich: „Offen +
  // Garten" faellt mit „Offen" zusammen, sobald es Garten nicht mehr gibt.
  // Zwei sicht- und verhaltensgleiche Pillen nebeneinander sind keine Auswahl.
  // `saveRecentFilter` kann die Dublette nicht verdraengen - es vergleicht die
  // UNGEFILTERTEN Schluessel, und die gehen ja gerade noch auseinander.
  // Entdoppelt wird deshalb die ANSICHT, nicht der Speicher: kommt Garten
  // zurueck, sind es wieder zwei verschiedene Sets.
  const gesehen = new Set();
  return beschnitten.filter((f) => {
    const key = recentFilterKey(f);
    if (gesehen.has(key)) return false;
    gesehen.add(key);
    return true;
  });
}

/**
 * Kennung eines Filter-Sets.
 *
 * Jede Achse gehört mit allen ihren Werten hinein: sonst verdrängte
 * „Offen + Garten" den Eintrag „Offen + Haus", weil beide auf dieselbe Kennung
 * fielen - seit #671 gilt dasselbe für zwei Prioritäten statt einer.
 *
 * EINE Formel für zwei Verwendungen: `saveRecentFilter` verdrängt damit den
 * gleichen Eintrag im Speicher, `getRecentFilters` entdoppelt damit die
 * Ansicht. Zwei Kopien davon liefen genau dann auseinander, wenn eine neue
 * Achse dazukommt - und dann still.
 */
function recentFilterKey(f) {
  // STRUKTURELL KODIERT, NICHT MIT TRENNZEICHEN VERKETTET.
  //
  // Hier stand `join(',')` INNERHALB einer Achse, und das Komma darf in einem
  // Wert vorkommen: `normalizeTags` splittet nur eine STRING-Eingabe an
  // Kommas, ein Array-Element behaelt seines (`normalizeTags(['a,b'])` ->
  // `['a,b']`), und die Route nimmt Arrays. Damit ergaben der eine Tag `a,b`
  // und die zwei Tags `a` und `b` denselben Schluessel: `getRecentFilters`
  // verbarg den einen Chip als Dublette, und `saveRecentFilter` verdraengte
  // beim Speichern den jeweils anderen.
  //
  // Das `join('|')` DARUEBER war dagegen in Ordnung, auch wenn ein Tag ein
  // `|` tragen darf: die Achsenzahl ist fest, also bleibt jede Position
  // eindeutig. Eine Probe dafuer stand hier kurz und wurde wieder entfernt -
  // sie blieb gruen, wenn man den alten Trenner zuruecknahm, und maass damit
  // nichts. Ersetzt wird er trotzdem mit, weil eine Formel mit zwei Regeln
  // schwerer zu halten ist als eine ohne.
  //
  // Der Server hat dieselbe Frage schon beantwortet und begruendet
  // (`tagsKey` in server/utils/task-tags.js trennt mit U+0000, "weil ein Tag
  // Leerzeichen enthalten darf"). JSON braucht die Frage gar nicht erst zu
  // stellen: es kodiert die Achsen als Struktur, also kann kein Wert seinen
  // eigenen Trenner tragen. Der Schluessel wird bei jedem Aufruf neu gerechnet
  // und nirgends gespeichert - die geaenderte Form braucht keine Migration.
  const axis = (values) => [...values].map((v) => String(v).toLowerCase()).sort();
  return JSON.stringify([f.status, f.priority, f.assigned_to, f.category, f.tags].map(axis));
}

function saveRecentFilter(filters) {
  const set = normalizeFilterSet(filters);
  if (!set.status.length && !set.priority.length && !set.assigned_to.length && !set.category.length && !set.tags.length) return;
  const key = recentFilterKey(set);
  const recent = storedRecentFilters().filter((f) => recentFilterKey(f) !== key);
  recent.unshift(set);
  try { localStorage.setItem(RECENT_FILTERS_KEY, JSON.stringify(recent.slice(0, RECENT_FILTERS_MAX))); } catch {}
}

function wireSwipeGestures(container) {
  const listEl = container.querySelector('#task-list');
  if (!listEl) return;

  wireSwipeRows(listEl, {
    card: '.task-card',
    // Vor 2.0.0 öffnete derselbe Wisch hier den Bearbeiten-Dialog: eine der
    // zwei Listen, in denen die Seiten wirklich getauscht haben.
    sidesSwapped: true,
    // Zeilenanfang: Status umschalten - die primäre positive Aktion der Liste
    // (§2: dieselbe Kante trägt sie in jeder Liste). Die Karte fliegt hinaus,
    // weil die Zeile danach in einer anderen Gruppe steht - ohne den Flug
    // spränge sie einfach weg.
    leading: {
      reveal: '.swipe-reveal--done',
      flyOut: true,
      run: async (row) => {
        const taskId = row.dataset.swipeId;
        const capturedStatus = row.dataset.swipeStatus;
        const nextStatus = capturedStatus === 'done' ? 'open' : 'done';
        try {
          await toggleTaskStatus(taskId, capturedStatus);
          await loadTasks(container);
          window.yuvomi.showToast(
            t(nextStatus === 'done' ? 'tasks.swipedDoneToast' : 'tasks.swipedOpenToast'),
            'default',
            5000,
            async () => {
              try {
                await toggleTaskStatus(taskId, nextStatus);
                await loadTasks(container);
              } catch (err) {
                window.yuvomi.showToast(err.message, 'danger');
              }
            },
          );
        } catch (err) {
          window.yuvomi.showToast(err.message, 'danger');
          await loadTasks(container);
        }
      },
    },
    // Zeilenende: Detailansicht - hier die sekundäre Aktion, weil die Liste
    // eine positive führt. Die Zeile bleibt, also federt die Karte zurueck.
    trailing: {
      reveal: '.swipe-reveal--edit',
      run: async (row) => {
        const taskId = row.dataset.swipeId;
        try {
          const [task, reminder] = await Promise.all([
            loadTaskForEdit(taskId),
            loadReminderForTask(taskId),
          ]);
          openTaskView(task, reminder, container);
        } catch (err) {
          window.yuvomi.showToast(t('tasks.loadError'), 'danger');
        }
      },
    },
  });
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
    state.filters = { status: [], priority: [], assigned_to: [], category: [], tags: [] };
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

  // "Mir zugewiesen" Toggle — nimmt die eigene ID in den Personen-Filter auf
  // bzw. wieder heraus. Seit #671 eine Achse mit mehreren Werten: eine bereits
  // gewählte zweite Person bleibt dabei stehen, statt still zu verschwinden.
  container.querySelector('#filter-assigned-me')?.addEventListener('click', async () => {
    await toggleValueFilter('assigned_to', state.currentUserId, container);
  });

  // Chip-Klicks (in Bar + Panel)
  container.querySelectorAll('[data-filter]').forEach((chip) => {
    chip.addEventListener('click', async () => {
      const filter = chip.dataset.filter;
      if (filter === 'tag') {
        await toggleTagFilter(chip.dataset.value, container);
        return;
      }
      await toggleValueFilter(filter, chip.dataset.value, container);
    });
  });

  // Recent-Filter-Chips anwenden
  container.querySelectorAll('[data-recent-filter]').forEach((chip) => {
    chip.addEventListener('click', async () => {
      try {
        state.filters = normalizeFilterSet(JSON.parse(chip.dataset.recentFilter));
      } catch { return; }
      renderFilters(container);
      await loadTasks(container);
    });
  });
}

/**
 * Alles am Seitenkopf, was von der gewaehlten Ansicht abhaengt - an EINER
 * Stelle.
 *
 * Vorher stand dieselbe Bedingung zweimal da: einmal als Interpolation im
 * Anfangs-Markup, einmal im Klick-Handler des Umschalters. Mit zwei Ansichten
 * ging das gerade noch gut; mit der dritten waeren es zwei Listen gewesen, die
 * auseinanderlaufen koennen, und eine davon haette den Verlauf vergessen.
 *
 * Sichtbarkeit ueber [hidden] statt style.display: ein Zustand, den auch
 * assistive Technik als „nicht vorhanden" liest.
 */
function syncViewChrome(container) {
  const mode = state.viewMode;
  const isList = mode === 'list';
  const isHistory = mode === 'history';

  container.querySelectorAll('#view-toggle [data-view]').forEach((b) => {
    const on = b.dataset.view === mode;
    b.classList.toggle('group-toggle__btn--active', on);
    b.setAttribute('aria-pressed', String(on));
  });

  // EIN KOPF, EINE BREITE (#1012, nach der Kalender-Entscheidung vom
  // 2026-08-27): der Kopf steht ueber drei Koerpern und haelt die Kante des
  // breitesten, des Kanban-Boards. Bis dahin toggelte der Kopf seinen
  // Lesemass-Modifier mit der Ansicht (Critique 2026-08-13) und sprang beim
  // Wechsel - genau das, was @Kyrodan gemeldet hat. Das Lesemass haengt jetzt
  // wie im Kalender an der SEITE: die Wurzel ist `app-page--full` (kein Mass),
  // Liste und Verlauf holen sich die Lesebahn per `is-reading-measure` zurueck,
  // ihre Zeilen und die Filterzeile kappen sich selbst daran (layout.css,
  // `.app-page :is(.tasks-filters-row, ...)`), das Board bleibt ungekappt.
  // Die Gegenrichtung - Seite auf Lesemass, Kopf freigeben - gibt es nicht:
  // PAGE-016 verlangt, dass ein Mass, das etwas kappt, im Kopf sichtbar ist.
  container.querySelector('.tasks-page')?.classList.toggle('is-reading-measure', !isKanbanMode());

  // Suche, Filterleiste, Gruppierung und Sammelauswahl fragen alle nach
  // AUFGABEN. Der Verlauf zeigt Vorgaenge - ein Statusfilter darueber waere
  // eine Auswahl, die nichts veraendern kann.
  const search = container.querySelector('.tasks-toolbar__search');
  if (search) search.hidden = isHistory;
  const filtersRow = container.querySelector('.tasks-filters-row');
  if (filtersRow) filtersRow.hidden = isHistory;
  // Das aufgeklappte Filter-Panel ist ein GESCHWISTER der Zeile, kein Kind -
  // die Zeile zu verstecken laesst es stehen, und dann schwebten Status- und
  // Prioritaets-Chips ueber einer Liste von Vorgaengen.
  const filterPanel = container.querySelector('#filter-panel');
  if (filterPanel && isHistory) filterPanel.hidden = true;
  const groupToggle = container.querySelector('#group-mode-toggle');
  if (groupToggle) groupToggle.hidden = !isList;
  const bulkSelectBtn = container.querySelector('#btn-bulk-select');
  if (bulkSelectBtn) {
    bulkSelectBtn.hidden = !isList;
    if (!isList) {
      state.bulkSelectMode = false;
      state.selectedTaskIds.clear();
      bulkSelectBtn.classList.remove('btn--active');
      bulkSelectBtn.setAttribute('aria-pressed', 'false');
    }
  }
  // Die Auswahl zu LEEREN raeumt die Leiste nicht weg: sie haengt an
  // `bar.hidden`, das nur updateBulkActionsBar setzt. Ohne diesen Aufruf blieb
  // „Als erledigt markieren / Ablegen / Loeschen" ueber dem Verlauf stehen -
  // mit leerer Auswahl, also Knoepfe ohne Gegenstand.
  updateBulkActionsBar(container);
}

/** Nimmt die Ansicht die volle Content-Spalte ein? */
function isKanbanMode() {
  return state.viewMode === 'kanban';
}

function wireViewToggle(container) {
  const toggle = container.querySelector('#view-toggle');
  if (!toggle) return;
  syncViewChrome(container);
  toggle.querySelectorAll('[data-view]').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.viewMode = btn.dataset.view;
      localStorage.setItem('yuvomi-tasks-view', state.viewMode);
      renderFilters(container);
      syncViewChrome(container);

      // Skeleton-Flash: einen Frame Render-Feedback geben, dann Ansicht aufbauen
      const listEl = container.querySelector('#task-list');
      if (listEl) listEl.style.opacity = '0.4';
      const restore = () => {
        const el = container.querySelector('#task-list');
        if (el) { el.style.transition = 'opacity 0.15s'; el.style.opacity = ''; }
      };
      requestAnimationFrame(() => {
        // Der Verlauf holt Vorgaenge, die beiden anderen Ansichten Aufgaben -
        // zwei Abfragen, und der Umschalter darf nicht die falsche fahren. Ein
        // gemeinsames loadTasks() haette den Verlauf mit einer Aufgabenliste
        // befuellt, die er gar nicht anzeigt.
        if (state.viewMode === 'history') {
          loadHistory(container).finally(restore);
          return;
        }
        // Task-Menge neu laden: der Kanban lädt alle Stati (kein status-Param),
        // die Liste wendet den Statusfilter wieder an (Audit A1-07/P3). Fällt bei
        // Netzfehler auf ein reines Re-Render der vorhandenen Aufgaben zurück.
        loadTasks(container).catch(() => renderTaskList(container)).finally(() => {
          updateBulkActionsBar(container);
          restore();
        });
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
      toggle.querySelectorAll('.group-toggle__btn').forEach((b) => {
        const on = b.dataset.mode === state.groupMode;
        b.classList.toggle('group-toggle__btn--active', on);
        b.setAttribute('aria-pressed', String(on));
      });
      renderTaskList(container);
    });
  });
}

function wireNewTaskBtn(container) {
  const handler = () => {
    openTaskModal({ users: state.users }, container);
  };
  container.querySelector('#btn-new-task')?.addEventListener('click', handler);
  findPageFab('fab-new-task')?.addEventListener('click', handler);
}

function updateBulkActionsBar(container) {
  const bar = container.querySelector('#bulk-actions-bar');
  const count = container.querySelector('#bulk-count');
  if (!bar) return;

  const selected = state.selectedTaskIds.size;
  const buttons = bar.querySelectorAll('button[id^="bulk-"]');

  bar.hidden = !(state.bulkSelectMode && selected > 0);
  bar.classList.toggle('bulk-actions-bar--active', selected > 0);
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
    toggleBtn.setAttribute('aria-pressed', String(state.bulkSelectMode));
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

    // Löschen läuft über dasselbe Optimistic-Undo-Muster wie der Einzel-Delete
    // (kein ungestylter window.confirm, immer rückgängig machbar — Critique P1).
    if (action === 'bulk-delete') {
      handleBulkDelete(taskIds, container);
      return;
    }

    if (action === 'bulk-tag-add' || action === 'bulk-tag-remove') {
      openBulkTagDialog(taskIds, action === 'bulk-tag-add' ? 'add' : 'remove', container);
      return;
    }

    try {
      if (action === 'bulk-mark-done' || action === 'bulk-mark-open') {
        const status = btn.dataset.status;
        await Promise.all(taskIds.map(id => api.patch(`/tasks/${id}/status`, { status })));
        window.yuvomi.showToast(t('tasks.bulkStatusChanged'), 'success');
      } else if (action === 'bulk-archive') {
        await Promise.all(taskIds.map(id => setTaskArchived(id, true)));
        window.yuvomi.showToast(t('tasks.bulkArchived'), 'success');
      }

      state.selectedTaskIds.clear();
      updateBulkActionsBar(container);
      await loadTasks(container);
    } catch (err) {
      window.yuvomi.showToast(err.message ?? t('common.errorGeneric'), 'danger');
    }
  });
}

// Bulk-Delete mit Optimistic-Update + Undo-Toast — spiegelt handleDeleteTask
// für mehrere Aufgaben: Karten sofort ausblenden, 5s Undo-Fenster, dann erst
// die API-Aufrufe. Ersetzt den nativen window.confirm-Dialog (Critique P1).
function handleBulkDelete(taskIds, container) {
  const els = taskIds
    .map(id => container.querySelector(`[data-task-id="${id}"]`))
    .filter(Boolean);
  const prevDisplay = new Map();
  els.forEach(el => { prevDisplay.set(el, el.style.display); el.style.display = 'none'; });

  state.selectedTaskIds.clear();
  updateBulkActionsBar(container);

  const restore = () => els.forEach(el => { el.style.display = prevDisplay.get(el) ?? ''; });

  scheduleUndoableDelete({
    message: t('tasks.bulkDeleted'),
    commit: async ({ keepalive }) => {
      await Promise.all(taskIds.map(id => api.delete(`/tasks/${id}`, { keepalive })));
      taskIds.forEach(id => api.delete(`/reminders?entity_type=task&entity_id=${id}`, { keepalive }).catch(() => {}));
      if (keepalive) return; // Seite verschwindet — kein UI-Refresh mehr
      refreshReminders();
      await loadTasks(container);
    },
    restore: (err) => {
      restore();
      if (err) window.yuvomi.showToast(err.message ?? t('common.unknownError'), 'danger');
    },
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
      const nextStatus = status === 'done' ? 'open' : 'done';
      vibrate(15);
      // Beide Zustandsklassen führen, nicht nur die neue anhängen: der Knopf
      // trug sonst `--open` UND `--done` gleichzeitig (gemessen 2026-08-28),
      // und die Regel, die zuletzt im Stylesheet steht, gewann das Aussehen.
      target.classList.toggle('task-status-btn--done', nextStatus === 'done');
      target.classList.toggle('task-status-btn--open', nextStatus !== 'done');
      target.closest('.task-card')?.classList.toggle('task-card--done', nextStatus === 'done');
      // Die Quittung startet JETZT und läuft neben dem Roundtrip, nicht danach:
      // `loadTasks()` ersetzt den Knopf, und ohne dieses Warten war `check-pop`
      // (tasks.css:703) in 0 von 6 Messungen zu sehen. Siehe animationSettled().
      const settled = animationSettled(target);
      try {
        await toggleTaskStatus(id, status);
        await settled;
        await loadTasks(container);
        // Derselbe Rückweg wie beim Wischen. Die Geste hatte hier zwei
        // Endpunkte mit zwei Antworten: der Wisch bot Undo an, der Tipp - die
        // häufigere Bedienung - liess den Eintrag kommentarlos aus dem
        // gefilterten Bild verschwinden.
        //
        // Die Schlüssel heissen weiter `swiped*`: ihr TEXT ist gestenneutral
        // ("Als erledigt markiert."), nur der Name nennt die Wischgeste. Ein
        // Rename kostet 24 Locale-Dateien für eine Namensschuld, die kein
        // Nutzer sieht - vermerkt statt bezahlt.
        window.yuvomi.showToast(
          t(nextStatus === 'done' ? 'tasks.swipedDoneToast' : 'tasks.swipedOpenToast'),
          'default',
          5000,
          async () => {
            try {
              await toggleTaskStatus(id, nextStatus);
              await loadTasks(container);
            } catch (err) {
              window.yuvomi.showToast(err.message, 'danger');
            }
          },
        );
      } catch (err) {
        window.yuvomi.showToast(err.message, 'danger');
        await loadTasks(container);
      }
    }

    if (action === 'toggle-subtasks') {
      const subtaskList = document.getElementById(`subtasks-${id}`);
      if (subtaskList) {
        const open = subtaskList.classList.toggle('subtask-list--visible');
        target.setAttribute('aria-expanded', String(open));
      }
    }

    if (action === 'toggle-subtask') {
      try {
        await toggleSubtaskStatus(id, target.dataset.status);
        await loadTasks(container);
      } catch (err) {
        window.yuvomi.showToast(err.message, 'danger');
      }
    }

    if (action === 'edit-task' || action === 'open-task') {
      try {
        const [task, reminder] = await Promise.all([
          loadTaskForEdit(id),
          loadReminderForTask(id),
        ]);
        openTaskView(task, reminder, container);
      } catch (err) {
        window.yuvomi.showToast(t('tasks.loadError'), 'danger');
      }
    }

    if (action === 'archive-task' || action === 'unarchive-task') {
      const archive = action === 'archive-task';
      try {
        await setTaskArchived(id, archive);
        window.yuvomi.showToast(archive ? t('tasks.archivedToast') : t('tasks.unarchivedToast'), 'success');
        await loadTasks(container);
      } catch (err) {
        window.yuvomi.showToast(err.message, 'danger');
      }
    }

    if (action === 'add-subtask') {
      await addSubtask(target.dataset.parent, { onChanged: () => loadTasks(container) });
    }

    if (action === 'rename-subtask') {
      await handleRenameSubtask(id, target.dataset.title, container);
    }

    if (action === 'delete-subtask') {
      await handleDeleteSubtask(id, target.dataset.title, container);
    }
  });
}

// --------------------------------------------------------
// Haupt-Render
// --------------------------------------------------------

/**
 * Die geteilte Leseansicht mit dem Kontext DIESER Seite.
 *
 * Das Bearbeiten-Formular wird hier eingehaengt und nicht in der Komponente:
 * es gehoert dem Aufgabenmodul. Die Ansicht selbst kommt ohne aus (#918) - wer
 * sie ohne Mounter oeffnet, bekommt eine ohne Bearbeiten-Knopf statt einen,
 * der ins Leere fuehrt.
 */
function openTaskView(task, reminder, container) {
  openTaskDetail({
    task,
    reminder,
    users: state.users,
    currentUserId: state.currentUserId,
    isAdmin: state.isAdmin,
    categories: state.categories,
    container,
    onChanged: () => loadTasks(container),
    edit: {
      mount: (panel, pane) => {
        // Working-Set VOR dem Rendern setzen: renderTagChips in wireTaskForm
        // liest ihn direkt danach.
        modalTags = normalizeTagList(task.tags);
        pane.insertAdjacentHTML('beforeend', renderModalContent({ task, users: state.users, reminder }));
        wireTaskForm(panel, { task, container });
      },
    },
  });
}

/**
 * Das Blatt dieses Moduls sicherstellen, wenn es von aussen geoeffnet wird.
 *
 * DER ROUTER HAELT GENAU EIN SEITEN-BLATT (loadPageStyle in router.js). Auf der
 * Uebersicht ist das dashboard.css, im Kalender calendar.css - tasks.css ist
 * dort nicht geladen. Die Leseansicht einer Aufgabe UND das Bearbeiten-Formular
 * holen ihr Aussehen aber von dort: Kommentare, Dokument-Chips,
 * Bildvorschauen, Etiketten, Prioritaets-Abzeichen, der Serienverlauf, und im
 * Formular die Tag-Zeile und die Feldhinweise. Ohne dieses Blatt erscheint das
 * alles fast ungestaltet - gemessen kam ein Etikett mit `border-radius: 0`
 * heraus und die Autorenzeile eines Kommentars mit Gewicht 400.
 *
 * EIN Blatt statt zweier Haelften, und das ist die eigentliche Entscheidung:
 * Die Regeln zwischen einem geteilten und einem Seiten-Blatt aufzuteilen hiesse,
 * bei jeder neuen Regel richtig einzusortieren - eine Sortierarbeit, die still
 * schiefgeht und zweimal schiefgegangen ist (`.priority-badge` blieb zurueck,
 * die Formularregeln alle). Wer das Modul von aussen oeffnet, bekommt sein
 * Blatt; das ist eine Regel statt einer Liste.
 *
 * GEWARTET WIRD DARAUF, sonst zeigt die Ansicht ihren Inhalt einmal roh.
 * Dasselbe Muster wie `loadReminderStyles` im Router, nur mit dem `onload`
 * davor. Der Fehlerfall loest ebenfalls auf: ein fehlendes Blatt ist ein
 * Schoenheitsfehler, kein Grund, die Aufgabe nicht zu zeigen.
 */
function ensureTaskStyles() {
  const href = '/styles/tasks.css';
  // Auch das Seiten-Blatt des Routers zaehlt: steht man auf /tasks, ist es da.
  if ([...document.styleSheets].some((sheet) => (sheet.href ?? '').endsWith(href))) return Promise.resolve();
  const vorhanden = document.querySelector(`link[data-task-styles][href="${href}"]`);
  if (vorhanden) return vorhanden.dataset.ready === '1'
    ? Promise.resolve()
    : new Promise((resolve) => vorhanden.addEventListener('load', resolve, { once: true }));

  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = href;
  link.dataset.taskStyles = '';
  const ready = new Promise((resolve) => {
    link.onload = () => { link.dataset.ready = '1'; resolve(); };
    link.onerror = () => { link.dataset.ready = '1'; resolve(); };
  });
  document.head.appendChild(link);
  return ready;
}

/**
 * Eine Aufgabe oeffnen, ohne auf dieser Seite zu stehen (#918).
 *
 * Der Einstieg fuer die Uebersicht, die vier Kalenderansichten, das
 * Dringend-Widget und das Cockpit. Sie zeigen alle dieselbe Aufgabe an und
 * hatten bis dahin nur zwei Moeglichkeiten: ein eigenes, kleineres Kaertchen
 * bauen oder den Nutzer hierher schicken. Beide waren im Einsatz.
 *
 * Geladen wird hier, nicht beim Aufrufer: was eine Aufgabe zum Anzeigen
 * braucht - die vollstaendige Zeile, ihre Erinnerung, die Mitglieder und die
 * Kategorien des Haushalts - weiss dieses Modul, und ein Widget, das sich das
 * selbst zusammensucht, waere die naechste Fassung, die auseinanderlaeuft.
 *
 * `state` wird dabei nur gefuellt, soweit die Ansicht es liest; die Liste
 * dieser Seite bleibt unberuehrt, weil sie in diesem Fall gar nicht steht.
 *
 * @param {number|string} taskId
 * @param {{user?: object|null, container?: HTMLElement|null,
 *          onChanged?: () => (void|Promise<void>)}} opts
 *        `user` ist der angemeldete Mensch, so wie der Router ihn der
 *        aufrufenden Seite gibt. Er steht im Aufruf und wird NICHT aus einem
 *        Global geraten: an ihm haengt, wem seine eigenen Kommentare gehoeren
 *        und wer eine gesperrte Aufgabe umschreiben darf (#830). Fehlt er,
 *        bietet die Ansicht weniger an, als erlaubt waere - still und falsch.
 *        `container` ist die Umgebung, aus der geoeffnet wurde - sie liefert
 *        die Zeile fuers optimistische Ausblenden beim Loeschen. `onChanged`
 *        frischt genau diese Umgebung auf.
 */
export async function openTaskById(taskId, { user = null, container = null, onChanged = () => {} } = {}) {
  const [task, reminder] = await Promise.all([
    loadTaskForEdit(taskId),
    loadReminderForTask(taskId),
    ensureTaskStyles(),
  ]);
  if (!task) throw new Error(t('tasks.loadError'));

  // Mitglieder, Kategorien und Tags einmal holen, wenn diese Seite noch nie
  // stand. Ohne sie blieben @-Erwaehnungen unaufgeloest, die Kategoriezeile
  // zeigte ihren internen Schluessel und das Bearbeiten-Formular haette keine
  // Auswahl anzubieten.
  //
  // `meta` kommt OHNE `data`-Huelle: /tasks/meta/options antwortet mit den
  // Feldern direkt (server/routes/tasks.js), anders als die uebrigen Routen
  // dieses Moduls. Ein `meta.data?.users` daneben laese still `undefined`.
  if (!state.users.length || !state.categories.length) {
    try {
      const { data: meta = {}, fromCache } = await api.getWithSource('/tasks/meta/options');
      const alleStale = fromCache === true;
      state.metaStale = { users: alleStale, categories: alleStale, tags: alleStale };
      state.users         = meta.users      ?? state.users;
      state.categories    = meta.categories ?? state.categories;
      state.allTags       = meta.tags       ?? state.allTags;
      state.defaultPoints = Number(meta.default_points) || state.defaultPoints;
    } catch { /* Ansicht steht auch ohne - nur weniger aufgeloest, siehe unten. */ }
  }
  if (user) {
    state.currentUserId = user.id ?? null;
    state.isAdmin       = user.role === 'admin';
  }

  // OHNE KATEGORIEN KEIN FORMULAR. Die Auswahl wird aus `state.categories`
  // gebaut; blieb der Aufruf oben ohne Antwort, stuende dort ein leeres
  // Auswahlfeld, und ein Speichern schickte eine leere Kategorie, die der
  // Server ablehnt - nachdem wartende Datei-Uploads bereits durch sind. Die
  // Leseansicht bleibt, der Bearbeiten-Knopf faellt weg: kein Knopf ist
  // ehrlicher als einer, der in einen Fehler laeuft (dieselbe Regel wie beim
  // fehlenden Mounter).
  const canOfferEdit = state.categories.length > 0;

  openTaskDetail({
    task,
    reminder,
    users: state.users,
    currentUserId: state.currentUserId,
    isAdmin: state.isAdmin,
    categories: state.categories,
    container,
    onChanged,
    edit: !canOfferEdit ? null : {
      mount: (panel, pane) => {
        modalTags = normalizeTagList(task.tags);
        pane.insertAdjacentHTML('beforeend', renderModalContent({ task, users: state.users, reminder }));
        // `container` reist MIT, obwohl es hier die Uebersicht ist und keine
        // Aufgabenliste haelt: sein zweiter Zweck ist das Ausblenden der Zeile
        // beim Loeschen. Ohne ihn haette derselbe Loeschbefehl zwei Verhalten -
        // ueber den Knopf der Leseansicht ginge die Zeile sofort, ueber den im
        // Formular bliebe sie den ganzen Rueckgaengig-Streifen lang stehen.
        // Nachgeladen wird trotzdem nichts Fremdes: `onChanged` ist gesetzt und
        // verdraengt den `loadTasks`-Default.
        wireTaskForm(panel, { task, container, onChanged });
      },
    },
  });
}

export async function render(container, { user }) {
  state.user = user ?? null;
  state.currentUserId = user?.id ?? null;
  loadCollapsedGroups();
  // Die Rolle entscheidet nur darüber, ob ein fremder Kommentar entfernt werden
  // darf (#734) - der Server prüft dieselbe Bedingung noch einmal.
  state.isAdmin = user?.role === 'admin';

  // „Mir zugewiesen" pro Gerät wiederherstellen (setzt assigned_to auf die eigene ID)
  try {
    if (state.currentUserId != null && localStorage.getItem(ASSIGNED_TO_ME_KEY) === '1') {
      if (!hasFilter('assigned_to', state.currentUserId)) {
        state.filters.assigned_to = [...state.filters.assigned_to, String(state.currentUserId)];
      }
    }
  } catch {}

  // View-Mode: URL-Parameter > localStorage > Default 'list'
  const urlView = new URLSearchParams(window.location.search).get('view');
  const savedView = localStorage.getItem('yuvomi-tasks-view');
  const KNOWN_VIEWS = ['list', 'kanban', 'history'];
  state.viewMode = KNOWN_VIEWS.includes(urlView) ? urlView
    : KNOWN_VIEWS.includes(savedView) ? savedView
    : 'list';

  // showFuture aus localStorage wiederherstellen
  try { state.showFuture = localStorage.getItem(SHOW_FUTURE_KEY) === '1'; } catch {}

  const isKanban = state.viewMode === 'kanban';
  // Was nur die Aufgabenliste betrifft, blendet `syncViewChrome` gleich nach
  // dem Einhängen aus - hier steht bewusst keine zweite Fassung derselben
  // Bedingung. `isHistory` traegt nur den Anfangszustand des Umschalters.
  const isHistory = state.viewMode === 'history';

  // Initiales Skeleton (all values are from i18n keys or hardcoded constants, no user data)
  container.replaceChildren();
  container.insertAdjacentHTML('beforeend', `
    <div class="tasks-page app-page app-page--full" data-composition="full">
      <div class="page-toolbar page-toolbar--wrap tasks-toolbar">
        <h1 class="page-toolbar__title">${t('tasks.title')}</h1>
        ${renderPageSearch({
          id: 'tasks-search',
          label: t('tasks.searchPlaceholder'),
          placeholder: t('tasks.searchPlaceholder'),
          value: state.searchQuery,
          clearLabel: t('common.searchClear'),
          className: 'tasks-toolbar__search page-toolbar__center',
        })}
        <div class="page-toolbar__actions">
          <!-- ICON PLUS LABEL, wie beim Geschwister-Umschalter in der Filterreihe
               (#group-mode-toggle, ~60 Zeilen tiefer). tasks.css:143 sagt ueber
               den Label-Verlust ausdruecklich „Der Ansichts-Umschalter im Kopf
               bekommt sie mit; er ist dasselbe Bauteil" - nur trug er gar kein
               Label, das haette fallen koennen. Die Regel lief hier ins Leere,
               und uebrig blieben drei stumme Glyphen (Critique 2026-08-28, P1:
               ein Kanban-Rechteck und ein Verlaufs-Pfeil sind kein geteiltes
               Vokabular). Unter 640px faellt das Label ueber die vorhandene
               Regel weg, mobil bleibt also die Icon-Form - iOS-Kanon.
               Die drei EINZELNEN Knoepfe daneben behalten ihre reine Icon-Form:
               ihre Namen sind Verben („Kategorien verwalten"), und ein
               aria-label als sichtbaren Text weiterzureichen verbietet
               DESIGN.md. Damit trennt jetzt auch der Text, was vorher nur die
               Behaelterform andeutete: benannte Ansichten in der Gruppe,
               unbenannte Werkzeuge daneben. -->
          <div class="group-toggle group-toggle--icons" id="view-toggle" role="group" aria-label="${t('tasks.viewToggleLabel')}">
            <button type="button" class="group-toggle__btn ${isKanban || isHistory ? '' : 'group-toggle__btn--active'}" data-view="list"
                    title="${t('tasks.listView')}" aria-label="${t('tasks.listView')}" aria-pressed="${!isKanban && !isHistory}">
              <i data-lucide="list" class="icon-md group-toggle__icon" aria-hidden="true"></i>
              <span class="group-toggle__label">${t('tasks.listView')}</span>
            </button>
            <button type="button" class="group-toggle__btn ${isKanban ? 'group-toggle__btn--active' : ''}" data-view="kanban"
                    title="${t('tasks.kanbanView')}" aria-label="${t('tasks.kanbanView')}" aria-pressed="${isKanban}">
              <i data-lucide="columns" class="icon-md group-toggle__icon" aria-hidden="true"></i>
              <span class="group-toggle__label">${t('tasks.kanbanView')}</span>
            </button>
            <button type="button" class="group-toggle__btn ${isHistory ? 'group-toggle__btn--active' : ''}" data-view="history"
                    title="${t('tasks.historyView')}" aria-label="${t('tasks.historyView')}" aria-pressed="${isHistory}">
              <i data-lucide="history" class="icon-md group-toggle__icon" aria-hidden="true"></i>
              <span class="group-toggle__label">${t('tasks.historyView')}</span>
            </button>
          </div>
          <button class="btn btn--ghost btn--icon" id="btn-bulk-select"
                  title="${t('tasks.bulkSelect')}" aria-label="${t('tasks.bulkSelect')}" aria-pressed="false">
            <i data-lucide="list-checks" class="icon-lg" aria-hidden="true"></i>
          </button>
          <button class="btn btn--icon btn--ghost" id="btn-manage-categories"
                  aria-label="${t('tasks.manageCategories')}" title="${t('tasks.manageCategories')}">
            <i data-lucide="folder-tree" class="icon-lg" aria-hidden="true"></i>
          </button>
          <!-- Der Tag-Verwalter bekommt das Etiketten-Icon, die Kategorien den
               Ordnerbaum: die beiden Achsen sind bewusst getrennt, und dieselbe
               Bildsprache für beide hätte genau das wieder eingeebnet. -->
          <button class="btn btn--icon btn--ghost" id="btn-manage-tags"
                  aria-label="${t('tasks.manageTags')}" title="${t('tasks.manageTags')}">
            <i data-lucide="tags" class="icon-lg" aria-hidden="true"></i>
          </button>
          <button class="btn btn--primary toolbar-new-btn" id="btn-new-task" style="gap:var(--space-1)"
                  aria-label="${t('tasks.newTask')}">
            <i data-lucide="plus" class="icon-lg" aria-hidden="true"></i> <span class="toolbar-new-btn__label">${t('newLabel.tasks')}</span>
          </button>
        </div>
      </div>

      <div class="tasks-body">
        <div class="tasks-filters-row">
          <div class="tasks-filters" id="filter-bar" role="group" aria-label="${t('tasks.filterBtn')}"></div>
          <div class="tasks-filters__end">
            <!-- Icon PLUS Label, nicht Icon ODER Label: unter 640px faellt das
                 Label weg (Label-Verlust-Regel, tasks.css), und dann traegt das
                 Icon allein. Das aria-label steht deshalb IMMER da - der
                 zugaengliche Name darf nicht an einer Media-Query haengen. -->
            <div class="group-toggle" id="group-mode-toggle" role="group"
                 aria-label="${t('tasks.groupToggleLabel')}">
              <button type="button" class="group-toggle__btn group-toggle__btn--active"
                      data-mode="category" aria-pressed="true"
                      aria-label="${t('tasks.categoryLabel')}">
                <i data-lucide="folder" class="group-toggle__icon" aria-hidden="true"></i>
                <span class="group-toggle__label">${t('tasks.categoryLabel')}</span>
              </button>
              <button type="button" class="group-toggle__btn"
                      data-mode="due" aria-pressed="false"
                      aria-label="${t('tasks.dueDateLabel')}">
                <i data-lucide="calendar-clock" class="group-toggle__icon" aria-hidden="true"></i>
                <span class="group-toggle__label">${t('tasks.dueDateLabel')}</span>
              </button>
            </div>
          </div>
        </div>
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
            <button class="btn btn--secondary btn--sm" id="bulk-tag-add">
              <i data-lucide="tag" class="icon-md" aria-hidden="true"></i>
              ${t('tasks.bulkTagAdd')}
            </button>
            <button class="btn btn--secondary btn--sm" id="bulk-tag-remove">
              <!-- Nicht "tag-off": das Icon gibt es im gebuendelten Lucide nicht,
                   der Knopf stand deshalb leer da. "eraser" traegt das Wegnehmen
                   und laesst sich vom "tag" des Nachbarknopfs unterscheiden -
                   zweimal dasselbe Icon nebeneinander waere keine Wahl. -->
              <i data-lucide="eraser" class="icon-md" aria-hidden="true"></i>
              ${t('tasks.bulkTagRemove')}
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
        <button class="page-fab" id="fab-new-task" aria-label="${t('tasks.newTask')}" data-dock-label="${t('newLabel.tasks')}">
          <i data-lucide="plus" class="icon-xl" aria-hidden="true"></i>
        </button>
      </div>
    </div>
  `);

  if (window.lucide) window.lucide.createIcons({ el: container });

  // Daten laden (Filter-State aus vorheriger Session berücksichtigen)
  try {
    const [tasksData, metaData, preferencesData] = await Promise.all([
      api.get(`/tasks${taskQuery()}`),
      api.getWithSource('/tasks/meta/options'),
      // Reine Anzeigepräferenz: ein Fehler hier darf die Aufgabenliste nicht
      // mit in den Ladefehler ziehen, deshalb eigener Fallback.
      api.get('/preferences').catch(() => ({ data: {} })),
    ]);
    state.loadError = null;
    // `metaData` traegt jetzt `{ data, fromCache }` - der Rumpf steht in `.data`.
    const meta = metaData.data ?? {};
    // `/tasks/meta/options` bringt als einziger Pfad alle drei.
    const alleStale = metaData.fromCache === true;
    state.metaStale = { users: alleStale, categories: alleStale, tags: alleStale };
    state.tasks = tasksData.data ?? [];
    state.users = meta.users ?? [];
    state.categories = meta.categories ?? [];
    state.allTags = meta.tags ?? [];
    state.defaultPoints = Number(meta.default_points) || 0;
    state.subtasksExpandedByDefault = preferencesData.data?.tasks_subtasks_expanded === true;
    state.defaultSyncTarget = preferencesData.data?.tasks_default_target || '';
  } catch (err) {
    console.error('[Tasks] Ladefehler:', err.message);
    // Der Toast allein war die falsche Antwort: er verging, und darunter blieb
    // „Keine Aufgaben - alles erledigt?" mit „Aufgabe erstellen" stehen. Bei
    // einem Serverfehler behauptet das nicht nur Datenverlust, es behauptet
    // Erledigung - und bietet als einzigen Ausweg eine schreibende Handlung.
    // Dieselbe Verwechslung, die Einkauf und Essensplan 2026-07-30 hatten
    // (Critique P0); `renderTaskList` prueft das Feld jetzt VOR dem Leer-Zweig.
    state.loadError = err;
    state.tasks = [];
    state.users = [];
    state.categories = [];
    state.allTags = [];
    state.metaStale = { users: false, categories: false, tags: false };
    state.defaultPoints = 0;
    state.subtasksExpandedByDefault = false;
    state.defaultSyncTarget = '';
  }

  // UI verdrahten
  wireViewToggle(container);
  wireGroupToggle(container);
  wireNewTaskBtn(container);
  wireTaskList(container);
  wireBulkSelect(container);
  wireBulkCheckboxes(container);
  wireBulkActions(container);
  wireTagBadgeFilter(container);
  container.querySelector('#btn-manage-categories')
    ?.addEventListener('click', () => openTaskCategoryManager(container));
  container.querySelector('#btn-manage-tags')
    ?.addEventListener('click', () => openTagManager(container));
  renderFilters(container);
  // Im Verlauf holt renderTaskList den Bestand selbst nach - er steckt nicht in
  // `/tasks`, und sein Ladefehler ist ein eigener.
  renderTaskList(container);

  wirePageSearch(container, {
    id: 'tasks-search',
    onQuery: (value) => {
      state.searchQuery = value;
      renderTaskList(container);
    },
  });

  // Deep-Link: ?open=<id> öffnet die Detailansicht
  const openId = new URLSearchParams(window.location.search).get('open');
  if (openId) {
    try {
      const [task, reminder] = await Promise.all([
        loadTaskForEdit(openId),
        loadReminderForTask(openId),
      ]);
      openTaskView(task, reminder, container);
    } catch { /* Task existiert nicht oder kein Zugriff */ }
  }
}

// Testfläche: nur reine Funktionen, deren Vertrag außerhalb dieser Datei zählt.
export const __test = {
  groupBy, groupKey, formatDueDate, normalizeFilterSet, taskQuery, state,
  // Gemerkte Filter: der Vertrag ist, dass Lesen und Schreiben AUSEINANDER
  // gehen - sonst schriebe das Bereinigen sich fest (siehe getRecentFilters).
  getRecentFilters, storedRecentFilters, saveRecentFilter,
  // Die Frische der Referenzlisten ist nur verhaltensgetrieben pruefbar: sie
  // haengt daran, WIE die Antwort kam, nicht daran, dass eine kam.
  refreshTags,
};
