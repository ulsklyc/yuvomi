# Design: Tasks als Kalender-Chips

**Datum:** 2026-05-27  
**Status:** Genehmigt  
**GitHub-Diskussion:** [#179](https://github.com/ulsklyc/oikos/discussions/179)

---

## Problem

Aufgaben mit Fälligkeitsdatum (`due_date`) sind nur in der Tasks-Ansicht sichtbar. Nutzer können termine und Aufgaben nicht im Kalender zusammen überblicken, was die zeitliche Planung erschwert.

## Ziel

Aufgaben mit `due_date` erscheinen automatisch als **read-only Chips** in allen vier Kalenderansichten (Monat, Woche, Tag, Agenda). So sehen Nutzer Aufgaben und Termine nebeneinander, ohne Daten zu duplizieren.

---

## Entscheidungen

| Frage | Entscheidung |
|---|---|
| Implementierungsansatz | Frontend-only: Tasks parallel zu Events laden |
| Erledigte Tasks anzeigen? | Nein – nur `open` / `in_progress` |
| Chip-Farbe | Prioritätsfarbe (`--color-priority-*`) |
| Interaktion bei Klick | Deep-Link → `/tasks?open=<id>` |

---

## Architektur

### Datenfluss

```
calendar.js render()
  ├── GET /api/v1/calendar/events?from=X&to=Y   (bestehend)
  └── GET /api/v1/tasks?include_future=1         (neu, parallel)

Beide Requests laufen via Promise.all().
Tasks werden client-seitig nach due_date auf den sichtbaren
Bereich gefiltert. Tasks ohne due_date oder mit Status
done/archived werden ignoriert.
```

### Keine Serveränderungen

Kein neues Backend, keine DB-Migration. Der bestehende `GET /api/v1/tasks`-Endpunkt liefert alle benötigten Felder (`id`, `title`, `due_date`, `due_time`, `priority`, `status`).

---

## Komponenten

### 1. `state.tasks` in `calendar.js`

Neues State-Feld `tasks: []` neben dem bestehenden `events: []`.

```js
let state = {
  // bestehend …
  events: [],
  tasks:  [],   // neu
};
```

### 2. `loadCalendarData(from, to)` — paralleler Fetch

```js
async function loadCalendarData(from, to) {
  const [eventsData, tasksData] = await Promise.all([
    api.get(`/calendar/events?from=${from}&to=${to}`),
    api.get('/tasks?include_future=1'),
  ]);
  state.events = eventsData.data ?? [];
  // Nur offene Tasks mit due_date filtern
  state.tasks = (tasksData.data ?? []).filter(
    (t) => t.due_date && t.status !== 'done' && t.status !== 'archived'
  );
}
```

### 3. `renderTaskChip(task)` — HTML-Baustein

```html
<div class="cal-task-chip cal-task-chip--<priority>"
     data-task-id="<id>"
     role="button"
     aria-label="<calendar.taskChipAriaLabel>">
  <i data-lucide="check-square" class="icon-xs" aria-hidden="true"></i>
  <span class="cal-task-chip__title"><escaped title></span>
</div>
```

- `priority` → `urgent | high | medium | low | none`
- Hintergrundfarbe via CSS: `background: var(--color-priority-<priority>)`

### 4. Integration in alle 4 Ansichten

| Ansicht | Position der Task-Chips |
|---|---|
| **Monat** | In der Tageszelle, nach Event-Chips |
| **Woche** | Im Ganztags-Bereich (bei `due_time` fehlt) oder in der Zeitraster-Zeile (bei `due_time` vorhanden) |
| **Tag** | Analog zu Woche |
| **Agenda** | Interleaved mit Events, nach Datum+Zeit sortiert |

Tasks mit `due_time` werden im Woche-/Tag-Zeitraster an der korrekten Zeitposition gerendert.  
Tasks ohne `due_time` erscheinen im Ganztags-Bereich.

### 5. Interaktion

Klick auf einen Task-Chip → `navigate('/tasks?open=<id>')`.  
Kein neues Modal, keine neue Route. Die bestehende Deep-Link-Mechanik in `tasks.js` öffnet das Edit-Modal automatisch.

---

## CSS

Neue Klassen in `public/styles/calendar.css` (oder eine eigene Datei `cal-task-chip.css`):

```css
.cal-task-chip {
  display: flex;
  align-items: center;
  gap: var(--space-1);
  padding: var(--space-0-5) var(--space-1-5);
  border-radius: var(--radius-sm);
  font-size: var(--text-xs);
  cursor: pointer;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  border: 1px solid transparent;
}

.cal-task-chip--urgent { background: var(--color-priority-urgent-bg); color: var(--color-priority-urgent); }
.cal-task-chip--high   { background: var(--color-priority-high-bg);   color: var(--color-priority-high);   }
.cal-task-chip--medium { background: var(--color-priority-medium-bg); color: var(--color-priority-medium); }
.cal-task-chip--low    { background: var(--color-priority-low-bg);    color: var(--color-priority-low);    }
.cal-task-chip--none   { background: var(--color-priority-none-bg);   color: var(--color-text-primary);    }
```

---

## Lokalisierung

Neue Schlüssel in **allen** `public/locales/*.json`:

```json
"calendar": {
  "taskChipAriaLabel": "Aufgabe: {{title}}"
}
```

---

## Fehlerbehandlung

- Schlägt der Tasks-Fetch fehl, zeigt der Kalender nur Events (kein Crash). Tasks-Fetch-Fehler wird mit `console.warn` protokolliert.
- Tasks ohne `due_date` werden stillschweigend ignoriert.

---

## Nicht im Scope

- Toggle-Button „Tasks anzeigen/ausblenden" (YAGNI – kann später ergänzt werden)
- Bidirektionale Sync (Task-Status aus Kalender ändern)
- Erstellen eines Kalender-Events aus einer Aufgabe
- Serverseitige Filterung nach Datumsbereich für Tasks

---

## Dateien, die geändert werden

| Datei | Änderung |
|---|---|
| `public/pages/calendar.js` | State, paralleler Fetch, `renderTaskChip()`, Integration in alle Views |
| `public/styles/calendar.css` | `.cal-task-chip`-Varianten |
| `public/locales/de.json` | `calendar.taskChipAriaLabel` |
| `public/locales/en.json` | `calendar.taskChipAriaLabel` |

---

## Erfolgskriterien

1. Tasks mit `due_date` erscheinen in allen 4 Kalenderansichten.
2. Tasks mit Status `done`/`archived` sind nicht sichtbar.
3. Klick auf Chip öffnet das Task-Edit-Modal.
4. Chip-Farbe entspricht der Priorität der Aufgabe.
5. Kein Absturz, wenn der Tasks-Endpunkt nicht erreichbar ist.
6. Alle UI-Texte über `t()` – keine hartkodierten Strings.
