# Tasks in Calendar Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Aufgaben mit `due_date` erscheinen als read-only Chips in allen 4 Kalenderansichten (Monat, Woche, Tag, Agenda); Klick öffnet das Task-Edit-Modal.

**Architecture:** Frontend-only. `calendar.js` holt Tasks parallel zu Events via `GET /api/v1/tasks?include_future=1`, filtert client-seitig nach `due_date` im sichtbaren Bereich, und rendert sie als `.cal-task-chip`-Elemente. Keine Serveränderungen, keine DB-Migration.

**Tech Stack:** Vanilla JS (ES modules), CSS Custom Properties aus `tokens.css`, Lucide Icons, `window.oikos.navigate`, `test-browser-loader.mjs` für Frontend-Tests.

---

## Dateien-Übersicht

| Datei | Änderung |
|---|---|
| `public/pages/calendar.js` | State, Fetch, Helper-Funktionen, alle 4 View-Renderer, Click-Handler, `__test`-Export |
| `public/styles/calendar.css` | `.cal-task-chip` + Prioritätsvarianten |
| `public/locales/de.json` | `calendar.taskChipAriaLabel` |
| `public/locales/en.json` | `calendar.taskChipAriaLabel` |
| `public/locales/ar.json` | `calendar.taskChipAriaLabel` |
| `public/locales/el.json` | `calendar.taskChipAriaLabel` |
| `public/locales/es.json` | `calendar.taskChipAriaLabel` |
| `public/locales/fr.json` | `calendar.taskChipAriaLabel` |
| `public/locales/hi.json` | `calendar.taskChipAriaLabel` |
| `public/locales/it.json` | `calendar.taskChipAriaLabel` |
| `public/locales/ja.json` | `calendar.taskChipAriaLabel` |
| `public/locales/pl.json` | `calendar.taskChipAriaLabel` |
| `public/locales/pt.json` | `calendar.taskChipAriaLabel` |
| `public/locales/ru.json` | `calendar.taskChipAriaLabel` |
| `public/locales/sv.json` | `calendar.taskChipAriaLabel` |
| `public/locales/tr.json` | `calendar.taskChipAriaLabel` |
| `public/locales/uk.json` | `calendar.taskChipAriaLabel` |
| `public/locales/zh.json` | `calendar.taskChipAriaLabel` |
| `test-calendar.js` | Neue Unit-Tests für Helper-Funktionen |

---

## Task 1: State & Helper-Funktionen in `calendar.js`

**Files:**
- Modify: `public/pages/calendar.js:327-335` (State), `570-576` (eventsOnDay), `582-593` (loadRange)

- [ ] **Schritt 1: `tasks: []` zum State-Objekt hinzufügen**

  Suche den `state`-Block (Zeile ~327) und ergänze `tasks: []`:

  ```js
  let state = {
    view:        'month',
    today:       '',
    cursor:      null,
    events:      [],
    tasks:       [],    // neu: Aufgaben mit due_date
    users:       [],
    rangeFrom:   '',
    rangeTo:     '',
  };
  ```

- [ ] **Schritt 2: `filterTasksForCalendar(tasks)` Helper nach `eventsOnDay` einfügen**

  Direkt nach der `eventsOnDay`-Funktion (Zeile ~576) einfügen:

  ```js
  /** Filtert Tasks: nur open/in_progress mit due_date werden angezeigt. */
  function filterTasksForCalendar(tasks) {
    return tasks.filter(
      (t) => t.due_date && t.status !== 'done' && t.status !== 'archived'
    );
  }

  /** Tasks, die an einem bestimmten Tag fällig sind. */
  function tasksOnDay(dateStr) {
    return state.tasks.filter((t) => t.due_date === dateStr);
  }
  ```

- [ ] **Schritt 3: `renderTaskChip(task)` Helper einfügen (direkt nach `tasksOnDay`)**

  ```js
  /** Rendert einen read-only Task-Chip für Kalenderansichten. */
  function renderTaskChip(task) {
    const priority = task.priority || 'none';
    const label    = esc(task.title);
    const ariaLbl  = t('calendar.taskChipAriaLabel', { title: task.title });
    const timeStr  = task.due_time ? ` · ${task.due_time.slice(0, 5)}` : '';
    return `<div class="cal-task-chip cal-task-chip--${priority}"
                 data-task-id="${task.id}"
                 role="button" tabindex="0"
                 aria-label="${esc(ariaLbl)}"
                 title="${label}${esc(timeStr)}">
      <i data-lucide="check-square" class="icon-xs" aria-hidden="true"></i>
      <span>${label}${esc(timeStr)}</span>
    </div>`;
  }
  ```

- [ ] **Schritt 4: `loadRange` erweitern um parallelen Tasks-Fetch**

  Ersetze die bestehende `loadRange`-Funktion (Zeile ~582):

  ```js
  async function loadRange(from, to) {
    try {
      const [evRes, taskRes] = await Promise.all([
        api.get(`/calendar?from=${from}&to=${to}`),
        api.get('/tasks?include_future=1').catch((err) => {
          console.warn('[Calendar] Tasks-Fetch fehlgeschlagen:', err);
          return { data: [] };
        }),
      ]);
      state.events = evRes.data;
      state.tasks  = filterTasksForCalendar(taskRes.data ?? []);
    } catch (err) {
      console.error('[Calendar] loadRange Fehler:', err);
      state.events = [];
      state.tasks  = [];
      window.oikos?.showToast(t('calendar.loadError'), 'danger');
    }
    state.rangeFrom = from;
    state.rangeTo   = to;
  }
  ```

- [ ] **Schritt 5: Neue Funktionen zum `__test`-Export hinzufügen**

  Suche die Zeile `export const __test = { normalizeCalendarView, defaultCalendarViewFromState };` (Zeile ~1156) und erweitere:

  ```js
  export const __test = {
    normalizeCalendarView,
    defaultCalendarViewFromState,
    filterTasksForCalendar,
    tasksOnDay,
  };
  ```

  Hinweis: `tasksOnDay` liest aus `state`, welches im Test-Context leer ist – für Tests wird `filterTasksForCalendar` direkt getestet.

- [ ] **Schritt 6: Tests schreiben – `test-calendar.js` ergänzen**

  Am Ende von `test-calendar.js` (nach dem letzten `test(…)` Block, vor dem Abschluss) einfügen:

  ```js
  // --------------------------------------------------------
  // Task-Chip-Helfer
  // --------------------------------------------------------

  console.log('\n[Calendar-Test] Task-Chip-Helfer\n');

  const { filterTasksForCalendar: ftc } = calendarHelpers;

  test('filterTasksForCalendar: Tasks ohne due_date werden gefiltert', () => {
    const tasks = [
      { id: 1, title: 'A', due_date: null,         status: 'open' },
      { id: 2, title: 'B', due_date: '2026-06-15', status: 'open' },
    ];
    const result = ftc(tasks);
    assert(result.length === 1, 'Nur 1 Task erwartet');
    assert(result[0].id === 2, 'Task B muss enthalten sein');
  });

  test('filterTasksForCalendar: done-Tasks werden gefiltert', () => {
    const tasks = [
      { id: 1, title: 'A', due_date: '2026-06-15', status: 'done'     },
      { id: 2, title: 'B', due_date: '2026-06-16', status: 'open'     },
      { id: 3, title: 'C', due_date: '2026-06-17', status: 'archived' },
    ];
    const result = ftc(tasks);
    assert(result.length === 1, 'Nur 1 Task erwartet');
    assert(result[0].id === 2, 'Nur offener Task erwartet');
  });

  test('filterTasksForCalendar: in_progress-Tasks werden behalten', () => {
    const tasks = [
      { id: 1, title: 'A', due_date: '2026-06-15', status: 'in_progress' },
    ];
    const result = ftc(tasks);
    assert(result.length === 1, 'in_progress-Task muss enthalten sein');
  });

  test('filterTasksForCalendar: leeres Array gibt leeres Array zurück', () => {
    assert(ftc([]).length === 0, 'Leeres Array erwartet');
  });
  ```

- [ ] **Schritt 7: Tests ausführen und sicherstellen, dass sie bestehen**

  ```bash
  cd "/Users/ulsklyc/Library/Mobile Documents/com~apple~CloudDocs/GitHub/oikos"
  npm run test:calendar
  ```

  Erwartete Ausgabe: Alle `✓`-Zeilen, 0 Fehler.

- [ ] **Schritt 8: Committen**

  ```bash
  cd "/Users/ulsklyc/Library/Mobile Documents/com~apple~CloudDocs/GitHub/oikos"
  git add public/pages/calendar.js test-calendar.js
  git commit -m "feat: add task helpers and state to calendar.js

  - Add tasks[] to calendar state
  - filterTasksForCalendar(): filters done/archived/no-date
  - tasksOnDay(dateStr): returns tasks due on a specific date
  - renderTaskChip(task): renders HTML chip for calendar views
  - loadRange() now fetches tasks in parallel (error-tolerant)
  - Unit tests for filterTasksForCalendar

  Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>"
  ```

---

## Task 2: CSS für Task-Chips

**Files:**
- Modify: `public/styles/calendar.css` (am Ende der Datei)

- [ ] **Schritt 1: CSS-Regeln ans Ende von `calendar.css` anhängen**

  ```css
  /* --------------------------------------------------------
   * Task-Chips im Kalender (read-only)
   * -------------------------------------------------------- */

  .cal-task-chip {
    display: flex;
    align-items: center;
    gap: var(--space-1);
    padding: var(--space-0-5) var(--space-1-5);
    border-radius: var(--radius-sm);
    font-size: var(--text-xs);
    font-weight: 500;
    cursor: pointer;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    min-width: 0;
    line-height: 1.3;
    user-select: none;
    margin-top: 2px;
  }

  .cal-task-chip:hover,
  .cal-task-chip:focus-visible {
    filter: brightness(0.92);
    outline: 2px solid var(--color-focus);
    outline-offset: 1px;
  }

  .cal-task-chip .icon-xs {
    width: 10px;
    height: 10px;
    flex-shrink: 0;
  }

  .cal-task-chip span {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  /* Prioritätsvarianten – nutzt dieselben -bg/-text-Token wie tasks.css */
  .cal-task-chip--urgent {
    background: var(--color-priority-urgent-bg);
    color: var(--color-priority-urgent);
  }
  .cal-task-chip--high {
    background: var(--color-priority-high-bg);
    color: var(--color-priority-high);
  }
  .cal-task-chip--medium {
    background: var(--color-priority-medium-bg);
    color: var(--color-priority-medium);
  }
  .cal-task-chip--low {
    background: var(--color-priority-low-bg);
    color: var(--color-priority-low);
  }
  .cal-task-chip--none {
    background: var(--color-priority-none-bg);
    color: var(--color-text-primary);
    border: 1px solid var(--color-border);
  }
  ```

  **Hinweis zu `--space-0-5` und `--space-1-5`:** Diese Tokens existieren in `tokens.css`. Prüfe mit `grep "space-0-5\|space-1-5" public/styles/tokens.css`. Falls sie nicht existieren, ersetze durch `2px` bzw. `6px`.

- [ ] **Schritt 2: Prüfen ob `--space-0-5` und `--space-1-5` existieren**

  ```bash
  grep "space-0-5\|space-1-5\|space-2:" "/Users/ulsklyc/Library/Mobile Documents/com~apple~CloudDocs/GitHub/oikos/public/styles/tokens.css" | head -5
  ```

  Falls die Tokens nicht existieren, ersetze in calendar.css:
  - `var(--space-0-5)` → `2px`
  - `var(--space-1-5)` → `6px`

- [ ] **Schritt 3: Committen**

  ```bash
  cd "/Users/ulsklyc/Library/Mobile Documents/com~apple~CloudDocs/GitHub/oikos"
  git add public/styles/calendar.css
  git commit -m "feat: add .cal-task-chip CSS for calendar task chips

  Priority variants use --color-priority-*-bg / --color-priority-*
  tokens, consistent with the tasks module.

  Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>"
  ```

---

## Task 3: Lokalisierung – `calendar.taskChipAriaLabel` in allen Locales

**Files:**
- Modify: `public/locales/de.json`, `en.json`, und alle weiteren 14 Locale-Dateien.

- [ ] **Schritt 1: `de.json` – Schlüssel am Ende des `"calendar"`-Blocks einfügen**

  Suche nach dem letzten Schlüssel im `"calendar"`-Block (z.B. `"agendaEmpty"` bei Zeile ~524).
  Füge **davor dem schließenden `}`** ein:

  ```json
  "taskChipAriaLabel": "Aufgabe: {{title}}"
  ```

- [ ] **Schritt 2: `en.json`**

  ```json
  "taskChipAriaLabel": "Task: {{title}}"
  ```

- [ ] **Schritt 3: `fr.json`**

  ```json
  "taskChipAriaLabel": "Tâche : {{title}}"
  ```

- [ ] **Schritt 4: `es.json`**

  ```json
  "taskChipAriaLabel": "Tarea: {{title}}"
  ```

- [ ] **Schritt 5: `it.json`**

  ```json
  "taskChipAriaLabel": "Attività: {{title}}"
  ```

- [ ] **Schritt 6: `pt.json`**

  ```json
  "taskChipAriaLabel": "Tarefa: {{title}}"
  ```

- [ ] **Schritt 7: `pl.json`**

  ```json
  "taskChipAriaLabel": "Zadanie: {{title}}"
  ```

- [ ] **Schritt 8: `sv.json`**

  ```json
  "taskChipAriaLabel": "Uppgift: {{title}}"
  ```

- [ ] **Schritt 9: `tr.json`**

  ```json
  "taskChipAriaLabel": "Görev: {{title}}"
  ```

- [ ] **Schritt 10: `ru.json`**

  ```json
  "taskChipAriaLabel": "Задача: {{title}}"
  ```

- [ ] **Schritt 11: `uk.json`**

  ```json
  "taskChipAriaLabel": "Завдання: {{title}}"
  ```

- [ ] **Schritt 12: `ar.json`**

  ```json
  "taskChipAriaLabel": "مهمة: {{title}}"
  ```

- [ ] **Schritt 13: `el.json`**

  ```json
  "taskChipAriaLabel": "Εργασία: {{title}}"
  ```

- [ ] **Schritt 14: `hi.json`**

  ```json
  "taskChipAriaLabel": "कार्य: {{title}}"
  ```

- [ ] **Schritt 15: `ja.json`**

  ```json
  "taskChipAriaLabel": "タスク: {{title}}"
  ```

- [ ] **Schritt 16: `zh.json`**

  ```json
  "taskChipAriaLabel": "任务：{{title}}"
  ```

- [ ] **Schritt 17: Prüfen, dass alle 16 Locale-Dateien den Schlüssel haben**

  ```bash
  grep -l "taskChipAriaLabel" "/Users/ulsklyc/Library/Mobile Documents/com~apple~CloudDocs/GitHub/oikos/public/locales/"*.json | wc -l
  ```

  Erwartete Ausgabe: `16`

- [ ] **Schritt 18: Committen**

  ```bash
  cd "/Users/ulsklyc/Library/Mobile Documents/com~apple~CloudDocs/GitHub/oikos"
  git add public/locales/
  git commit -m "i18n: add calendar.taskChipAriaLabel to all 16 locales

  Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>"
  ```

---

## Task 4: Monatsansicht – Task-Chips einfügen

**Files:**
- Modify: `public/pages/calendar.js:822-854` (`renderMonthDay`)

- [ ] **Schritt 1: `renderMonthDay` erweitern**

  Suche die Funktion `renderMonthDay(date, inMonth)` (Zeile ~822).

  **Vorher:**
  ```js
  function renderMonthDay(date, inMonth) {
    const evs      = eventsOnDay(date);
    const isToday  = date === state.today;
    const classes  = [
      'month-day',
      !inMonth ? 'month-day--outside' : '',
      isToday  ? 'month-day--today' : '',
    ].filter(Boolean).join(' ');

    const MAX_SHOW = 3;
    const shown    = evs.slice(0, MAX_SHOW);
    const extra    = evs.length - MAX_SHOW;

    const evHtml = shown.map((ev) => {
      const bg = ev.cal_color || ev.color;
      const fg = getContrastColor(bg);
      return `
      <div class="month-day__event"
           data-id="${ev.id}"
           style="background-color:${esc(bg)};${fg ? `color:${fg};` : ''}"
           title="${esc(ev.title)}${ev.cal_name ? ' · ' + ev.cal_name : ''}"
      >${eventIconHtml(ev.icon, 'event-icon event-icon--compact')}<span>${esc(ev.title)}</span>${(ev.recurrence_rule || ev.is_recurring_instance) ? '<i data-lucide="repeat" style="width:9px;height:9px;flex-shrink:0;opacity:0.7;margin-left:2px" aria-hidden="true"></i>' : ''}</div>
    `;
    }).join('');

    return `
      <div class="${classes}" data-date="${date}">
        <div class="month-day__number">${new Date(date + 'T00:00:00').getDate()}</div>
        ${evHtml}
        ${extra > 0 ? `<div class="month-day__more">${t('calendar.moreEvents', { count: extra })}</div>` : ''}
      </div>
    `;
  }
  ```

  **Nachher:**
  ```js
  function renderMonthDay(date, inMonth) {
    const evs      = eventsOnDay(date);
    const dayTasks = tasksOnDay(date);
    const isToday  = date === state.today;
    const classes  = [
      'month-day',
      !inMonth ? 'month-day--outside' : '',
      isToday  ? 'month-day--today' : '',
    ].filter(Boolean).join(' ');

    const MAX_SHOW = 3;
    const shown    = evs.slice(0, MAX_SHOW);
    const extra    = evs.length - MAX_SHOW;

    const evHtml = shown.map((ev) => {
      const bg = ev.cal_color || ev.color;
      const fg = getContrastColor(bg);
      return `
      <div class="month-day__event"
           data-id="${ev.id}"
           style="background-color:${esc(bg)};${fg ? `color:${fg};` : ''}"
           title="${esc(ev.title)}${ev.cal_name ? ' · ' + ev.cal_name : ''}"
      >${eventIconHtml(ev.icon, 'event-icon event-icon--compact')}<span>${esc(ev.title)}</span>${(ev.recurrence_rule || ev.is_recurring_instance) ? '<i data-lucide="repeat" style="width:9px;height:9px;flex-shrink:0;opacity:0.7;margin-left:2px" aria-hidden="true"></i>' : ''}</div>
    `;
    }).join('');

    const MAX_TASK_SHOW = 2;
    const taskHtml = dayTasks.slice(0, MAX_TASK_SHOW).map(renderTaskChip).join('');

    return `
      <div class="${classes}" data-date="${date}">
        <div class="month-day__number">${new Date(date + 'T00:00:00').getDate()}</div>
        ${evHtml}
        ${extra > 0 ? `<div class="month-day__more">${t('calendar.moreEvents', { count: extra })}</div>` : ''}
        ${taskHtml}
      </div>
    `;
  }
  ```

- [ ] **Schritt 2: Click-Handler im Monats-Grid erweitern**

  Suche den `container.querySelector('#month-grid').addEventListener('click', ...)` Block (Zeile ~807):

  **Vorher:**
  ```js
  container.querySelector('#month-grid').addEventListener('click', (e) => {
    const evEl = e.target.closest('.month-day__event');
    if (evEl) {
      e.stopPropagation();
      const ev = state.events.find((ev) => ev.id === parseInt(evEl.dataset.id, 10));
      if (ev) showEventPopup(ev, evEl);
      return;
    }
    const dayEl = e.target.closest('.month-day');
    if (dayEl) {
      openEventModal({ mode: 'create', date: dayEl.dataset.date });
    }
  });
  ```

  **Nachher:**
  ```js
  container.querySelector('#month-grid').addEventListener('click', (e) => {
    const taskChip = e.target.closest('.cal-task-chip');
    if (taskChip) {
      e.stopPropagation();
      window.oikos.navigate(`/tasks?open=${taskChip.dataset.taskId}`);
      return;
    }
    const evEl = e.target.closest('.month-day__event');
    if (evEl) {
      e.stopPropagation();
      const ev = state.events.find((ev) => ev.id === parseInt(evEl.dataset.id, 10));
      if (ev) showEventPopup(ev, evEl);
      return;
    }
    const dayEl = e.target.closest('.month-day');
    if (dayEl) {
      openEventModal({ mode: 'create', date: dayEl.dataset.date });
    }
  });
  ```

- [ ] **Schritt 3: Committen**

  ```bash
  cd "/Users/ulsklyc/Library/Mobile Documents/com~apple~CloudDocs/GitHub/oikos"
  git add public/pages/calendar.js
  git commit -m "feat(calendar): show task chips in month view

  Tasks with due_date appear as priority-colored read-only chips
  in month-day cells. Click navigates to /tasks?open=<id>.

  Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>"
  ```

---

## Task 5: Wochen- und Tagesansicht – Task-Chips im Ganztag-Bereich

**Files:**
- Modify: `public/pages/calendar.js` – `renderWeekView` (Zeile ~860), `renderDayView` (Zeile ~1054)

**Hinweis:** Task-Chips erscheinen **ausschließlich im Ganztag-Bereich** (allday-row), unabhängig davon ob `due_time` gesetzt ist. Chips mit `due_time` zeigen die Zeit im Label. Das vermeidet Konflikte mit dem Zeitraster-Layoutalgorithmus.

- [ ] **Schritt 1: `renderWeekView` – allday-Bereich um Task-Chips erweitern**

  Suche den `alldayEvs`-Block in `renderWeekView` (Zeile ~896–904):

  **Vorher (innerhalb der `days.map((d, i) => ...)` für den allday-Row):**
  ```js
  ${days.map((d, i) => `
    <div class="allday-cell">
      ${alldayEvs[i].map((ev) => `
        <div class="allday-event" data-id="${ev.id}"
             style="${ev.cal_color || ev.color ? `background-color:${esc(ev.cal_color || ev.color)};` : ''}${getContrastColor(ev.cal_color || ev.color) ? `color:${getContrastColor(ev.cal_color || ev.color)};` : ''}"
             title="${esc(ev.title)}${ev.cal_name ? ' · ' + ev.cal_name : ''}">${eventIconHtml(ev.icon, 'event-icon event-icon--compact')}<span>${esc(ev.title)}</span></div>
      `).join('')}
    </div>
  `).join('')}
  ```

  **Nachher:**
  ```js
  ${days.map((d, i) => `
    <div class="allday-cell">
      ${alldayEvs[i].map((ev) => `
        <div class="allday-event" data-id="${ev.id}"
             style="${ev.cal_color || ev.color ? `background-color:${esc(ev.cal_color || ev.color)};` : ''}${getContrastColor(ev.cal_color || ev.color) ? `color:${getContrastColor(ev.cal_color || ev.color)};` : ''}"
             title="${esc(ev.title)}${ev.cal_name ? ' · ' + ev.cal_name : ''}">${eventIconHtml(ev.icon, 'event-icon event-icon--compact')}<span>${esc(ev.title)}</span></div>
      `).join('')}
      ${tasksOnDay(d).map(renderTaskChip).join('')}
    </div>
  `).join('')}
  ```

- [ ] **Schritt 2: Click-Handler für allday-row in `renderWeekView` erweitern**

  Suche `container.querySelector('.allday-row').addEventListener('click', (e) => {` in `renderWeekView` (Zeile ~944):

  **Vorher:**
  ```js
  container.querySelector('.allday-row').addEventListener('click', (e) => {
    const evEl = e.target.closest('.allday-event');
    if (evEl) {
      const ev = state.events.find((ev) => ev.id === parseInt(evEl.dataset.id, 10));
      if (ev) showEventPopup(ev, evEl);
    }
  });
  ```

  **Nachher:**
  ```js
  container.querySelector('.allday-row').addEventListener('click', (e) => {
    const taskChip = e.target.closest('.cal-task-chip');
    if (taskChip) {
      window.oikos.navigate(`/tasks?open=${taskChip.dataset.taskId}`);
      return;
    }
    const evEl = e.target.closest('.allday-event');
    if (evEl) {
      const ev = state.events.find((ev) => ev.id === parseInt(evEl.dataset.id, 10));
      if (ev) showEventPopup(ev, evEl);
    }
  });
  ```

- [ ] **Schritt 3: `renderDayView` – allday-row anpassen**

  Suche den allday-Bereich in `renderDayView` (Zeile ~1067). Das allday-row-Element wird derzeit nur gerendert, wenn `allday.length > 0`. Erweitere die Bedingung so, dass auch Task-Chips gerendert werden:

  **Vorher:**
  ```js
  ${allday.length ? `
  <div class="allday-row" style="display:grid;grid-template-columns:48px 1fr;">
    <div style="padding:2px 4px 2px 0;font-size:10px;color:var(--color-text-disabled);text-align:right;line-height:24px;">${t('calendar.allDayShort')}</div>
    <div class="allday-cell">
      ${allday.map((ev) => `
        <div class="allday-event" data-id="${ev.id}"
             style="${ev.cal_color || ev.color ? `background-color:${esc(ev.cal_color || ev.color)};` : ''}${getContrastColor(ev.cal_color || ev.color) ? `color:${getContrastColor(ev.cal_color || ev.color)};` : ''}"
             title="${esc(ev.title)}${ev.cal_name ? ' · ' + ev.cal_name : ''}">${eventIconHtml(ev.icon, 'event-icon event-icon--compact')}<span>${esc(ev.title)}</span></div>`).join('')}
    </div>
  </div>` : ''}
  ```

  **Nachher:**
  ```js
  ${(allday.length || tasksOnDay(state.cursor).length) ? `
  <div class="allday-row" style="display:grid;grid-template-columns:48px 1fr;">
    <div style="padding:2px 4px 2px 0;font-size:10px;color:var(--color-text-disabled);text-align:right;line-height:24px;">${t('calendar.allDayShort')}</div>
    <div class="allday-cell">
      ${allday.map((ev) => `
        <div class="allday-event" data-id="${ev.id}"
             style="${ev.cal_color || ev.color ? `background-color:${esc(ev.cal_color || ev.color)};` : ''}${getContrastColor(ev.cal_color || ev.color) ? `color:${getContrastColor(ev.cal_color || ev.color)};` : ''}"
             title="${esc(ev.title)}${ev.cal_name ? ' · ' + ev.cal_name : ''}">${eventIconHtml(ev.icon, 'event-icon event-icon--compact')}<span>${esc(ev.title)}</span></div>`).join('')}
      ${tasksOnDay(state.cursor).map(renderTaskChip).join('')}
    </div>
  </div>` : ''}
  ```

- [ ] **Schritt 4: Click-Handler für allday-row in `renderDayView` erweitern**

  Suche `.allday-row` Click-Event in `renderDayView`. Falls er noch nicht existiert, füge ihn direkt nach der Schließung des `day-scroll`-Listeners ein. Falls er existiert, erweitere wie in Schritt 2 des gleichen Tasks.

  Direkt vor `const scroll = container.querySelector('#day-scroll');` einfügen (falls noch kein Handler vorhanden):

  ```js
  container.querySelector('.allday-row')?.addEventListener('click', (e) => {
    const taskChip = e.target.closest('.cal-task-chip');
    if (taskChip) {
      window.oikos.navigate(`/tasks?open=${taskChip.dataset.taskId}`);
      return;
    }
    const evEl = e.target.closest('.allday-event');
    if (evEl) {
      const ev = state.events.find((ev) => ev.id === parseInt(evEl.dataset.id, 10));
      if (ev) showEventPopup(ev, evEl);
    }
  });
  ```

- [ ] **Schritt 5: Committen**

  ```bash
  cd "/Users/ulsklyc/Library/Mobile Documents/com~apple~CloudDocs/GitHub/oikos"
  git add public/pages/calendar.js
  git commit -m "feat(calendar): show task chips in week and day views

  Task chips appear in the allday-row of week/day views.
  Tasks with due_time show the time in the chip label.
  Click navigates to /tasks?open=<id>.

  Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>"
  ```

---

## Task 6: Agenda-Ansicht – Task-Chips einfügen

**Files:**
- Modify: `public/pages/calendar.js:1119-1154` (`renderAgendaView`)

- [ ] **Schritt 1: `renderAgendaView` – Task-Chips in Tagesgruppen einfügen**

  Suche `renderAgendaView` (Zeile ~1119). Ändere die Funktion so, dass auch Tage mit Tasks (ohne Events) angezeigt werden und Task-Chips im Tagesblock erscheinen:

  **Vorher:**
  ```js
  function renderAgendaView(container) {
    const { from, to } = getAgendaRange(state.cursor);
    const days = Array.from({ length: 31 }, (_, i) => addDays(from, i));

    const groups = days
      .map((d) => ({ date: d, events: eventsOnDay(d) }))
      .filter((g) => g.events.length > 0);

    container.replaceChildren();
    container.insertAdjacentHTML('beforeend', `
      <div class="agenda-view" id="agenda-view">
        ${groups.length === 0
          ? `<div class="agenda-empty">${t('calendar.agendaEmpty')}</div>`
          : groups.map(({ date, events }) => `
            <div class="agenda-day">
              <div class="agenda-day__header ${date === state.today ? 'agenda-day__header--today' : ''}">
                <span class="agenda-day__date">${formatDate(date)}</span>
                <span class="agenda-day__weekday">${DAY_NAMES_LONG()[new Date(date + 'T00:00:00').getDay()]}</span>
              </div>
              ${events.map((ev) => renderAgendaEvent(ev)).join('')}
            </div>
          `).join('')
        }
      </div>
    `);

    stagger(container.querySelectorAll('.agenda-event'));

    container.querySelector('#agenda-view').addEventListener('click', (e) => {
      const evEl = e.target.closest('.agenda-event');
      if (evEl) {
        const ev = state.events.find((ev) => ev.id === parseInt(evEl.dataset.id, 10));
        if (ev) showEventPopup(ev, evEl);
      }
    });
  }
  ```

  **Nachher:**
  ```js
  function renderAgendaView(container) {
    const { from, to } = getAgendaRange(state.cursor);
    const days = Array.from({ length: 31 }, (_, i) => addDays(from, i));

    const groups = days
      .map((d) => ({ date: d, events: eventsOnDay(d), tasks: tasksOnDay(d) }))
      .filter((g) => g.events.length > 0 || g.tasks.length > 0);

    container.replaceChildren();
    container.insertAdjacentHTML('beforeend', `
      <div class="agenda-view" id="agenda-view">
        ${groups.length === 0
          ? `<div class="agenda-empty">${t('calendar.agendaEmpty')}</div>`
          : groups.map(({ date, events, tasks }) => `
            <div class="agenda-day">
              <div class="agenda-day__header ${date === state.today ? 'agenda-day__header--today' : ''}">
                <span class="agenda-day__date">${formatDate(date)}</span>
                <span class="agenda-day__weekday">${DAY_NAMES_LONG()[new Date(date + 'T00:00:00').getDay()]}</span>
              </div>
              ${events.map((ev) => renderAgendaEvent(ev)).join('')}
              ${tasks.length ? `<div class="agenda-tasks">${tasks.map(renderTaskChip).join('')}</div>` : ''}
            </div>
          `).join('')
        }
      </div>
    `);

    stagger(container.querySelectorAll('.agenda-event'));

    container.querySelector('#agenda-view').addEventListener('click', (e) => {
      const taskChip = e.target.closest('.cal-task-chip');
      if (taskChip) {
        window.oikos.navigate(`/tasks?open=${taskChip.dataset.taskId}`);
        return;
      }
      const evEl = e.target.closest('.agenda-event');
      if (evEl) {
        const ev = state.events.find((ev) => ev.id === parseInt(evEl.dataset.id, 10));
        if (ev) showEventPopup(ev, evEl);
      }
    });
  }
  ```

- [ ] **Schritt 2: `.agenda-tasks` Wrapper-CSS in `calendar.css` ergänzen**

  Füge nach dem `.cal-task-chip--none`-Block hinzu:

  ```css
  /* Aufgaben-Sektion in Agenda-Ansicht */
  .agenda-tasks {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-1);
    padding: var(--space-1) var(--space-3);
  }

  .agenda-tasks .cal-task-chip {
    margin-top: 0;
  }
  ```

- [ ] **Schritt 3: Alle Tests ausführen**

  ```bash
  cd "/Users/ulsklyc/Library/Mobile Documents/com~apple~CloudDocs/GitHub/oikos"
  npm run test:calendar
  ```

  Erwartete Ausgabe: Alle `✓`, 0 Fehler.

- [ ] **Schritt 4: Committen**

  ```bash
  cd "/Users/ulsklyc/Library/Mobile Documents/com~apple~CloudDocs/GitHub/oikos"
  git add public/pages/calendar.js public/styles/calendar.css
  git commit -m "feat(calendar): show task chips in agenda view

  Agenda view now shows tasks alongside events. Days with only
  tasks (no events) are also visible. Task chips appear in a
  flex-wrapped .agenda-tasks section per day group.

  Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>"
  ```

---

## Task 7: Abschluss-Tests und vollständiger Test-Run

- [ ] **Schritt 1: Alle Projekt-Tests ausführen**

  ```bash
  cd "/Users/ulsklyc/Library/Mobile Documents/com~apple~CloudDocs/GitHub/oikos"
  npm test
  ```

  Erwartete Ausgabe: Alle Test-Suites bestehen, 0 Fehler.

  Falls Tests fehlschlagen:
  - Syntaxfehler in `calendar.js` → im Browser-DevTools prüfen oder `node --loader ./test-browser-loader.mjs -e "await import('./public/pages/calendar.js')"` ausführen
  - `taskChipAriaLabel` fehlt → noch fehlende Locale-Dateien prüfen

- [ ] **Schritt 2: Visuellen Smoke-Test durchführen**

  ```bash
  cd "/Users/ulsklyc/Library/Mobile Documents/com~apple~CloudDocs/GitHub/oikos"
  npm run dev
  ```

  Öffne http://localhost:3000 im Browser:
  1. Erstelle eine Aufgabe mit `due_date` = heute und Priorität „hoch"
  2. Navigiere zum Kalender → Monatsansicht: Chip mit oranger Farbe auf dem heutigen Tag?
  3. Wechsle zur Wochenansicht: Chip im Ganztag-Bereich des heutigen Tags?
  4. Wechsle zur Tagesansicht: Chip im Ganztag-Bereich?
  5. Wechsle zur Agenda-Ansicht: Chip in der `.agenda-tasks`-Sektion?
  6. Klicke auf einen Chip → Navigiert zu `/tasks?open=<id>` und öffnet das Modal?

---

## Erfolgskriterien (aus Spec)

1. ✅ Tasks mit `due_date` erscheinen in allen 4 Kalenderansichten
2. ✅ Tasks mit Status `done`/`archived` sind nicht sichtbar
3. ✅ Klick auf Chip öffnet das Task-Edit-Modal
4. ✅ Chip-Farbe entspricht der Priorität der Aufgabe
5. ✅ Kein Absturz wenn Tasks-Endpunkt nicht erreichbar
6. ✅ Alle UI-Texte über `t()` – kein hardcodierter String
