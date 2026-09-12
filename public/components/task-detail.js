/**
 * Modul: Aufgaben-Leseansicht (geteilte Komponente)
 * Zweck: Eine Aufgabe ansehen und mit ihr arbeiten - Status weiterschalten,
 *        Teilaufgaben abhaken, Haken in der Beschreibung setzen, kommentieren,
 *        ablegen, löschen. Eine Fassung für jede Ansicht, die eine Aufgabe
 *        anzeigt.
 * Abhängigkeiten: components/detail-view.js (Präsentation), api.js,
 *                 utils/task-fields.js (was ein Feld bedeutet),
 *                 utils/day-label.js, tasks.css
 *
 * API:
 *   openTaskDetail({ task, reminder, users, currentUserId, isAdmin,
 *                    categories, container, onChanged, edit })
 *   deleteTaskWithUndo(id, { container, onChanged })
 *   addSubtask(parentId, { onChanged })
 *
 * WARUM DIESE DATEI EXISTIERT (#918). Die Ansicht lag in `pages/tasks.js` und
 * war damit nur von dort zu öffnen. Jede andere Stelle, die eine Aufgabe zeigt -
 * die Übersicht, die vier Kalenderansichten, das Dringend-Widget, das Cockpit -
 * hatte zwei Möglichkeiten: ein eigenes, kleineres Kärtchen bauen oder den
 * Nutzer ins Aufgabenmodul schicken. Beide waren im Einsatz, und beide waren
 * falsch: Die Übersicht ist die Ansicht, in der die App im Alltag benutzt wird,
 * und dort bot eine Aufgabe genau zwei Knöpfe an, während dieselbe Aufgabe eine
 * Seite weiter Teilaufgaben, Kommentare, Dokumente und abhakbare Zeilen in der
 * Beschreibung hatte.
 *
 * Der Markup zu duplizieren hätte garantiert, dass die beiden bei der nächsten
 * Änderung wieder auseinanderlaufen. Deshalb steht die Ansicht hier und die
 * Umgebung sagt ihr, was sie nicht wissen kann.
 */

import { api } from '/api.js';
import { t, formatDate, formatTime } from '/i18n.js';
import { openDetailView, closeDetailView, visibilityRow, assignedRow } from '/components/detail-view.js';
import { closeModal, promptModal, btnLoading, refocusAfterRender } from '/components/modal.js';
import { recurrenceRow } from '/rrule-ui.js';
import { scheduleUndoableDelete } from '/utils/ux.js';
import { renderMarkdownLight } from '/utils/html.js';
import { splitKeepingLineEndings } from '/utils/markdown-checklist.js';
import { splitMentions, applyMention } from '/utils/mentions.js';
import { refresh as refreshReminders } from '/reminders.js';
import { parseRemindAtAsUtc } from '/utils/reminder-offset.js';
import { isNavModuleReadOnly } from '/permissions.js';
import { zonedDateKey } from '/utils/timezone.js';
import { historyDayLabel } from '/utils/day-label.js';
import {
  FALLBACK_CATEGORY, PRIORITY_LABELS, STATUS_LABELS,
  isArchived, canEditTaskDefinition, catLabel, normalizeTagList,
  docMime, docHref, docIcon, formatDueDate,
} from '/utils/task-fields.js';

// --------------------------------------------------------
// Schreibwege, die die Ansicht selbst geht
// --------------------------------------------------------

export async function toggleSubtaskStatus(id, currentStatus) {
  const next = currentStatus === 'done' ? 'open' : 'done';
  await api.patch(`/tasks/${id}/status`, { status: next });
}

/** Ablegen bzw. zurückholen (#688) - der Status bleibt dabei, wie er war. */
export async function setTaskArchived(id, archived) {
  await api.patch(`/tasks/${id}/archive`, { archived });
}

/**
 * Jede Darstellung DIESER Aufgabe in der übergebenen Umgebung.
 *
 * Zwei Gründe, warum das kein `querySelector` mit einem Selektor ist:
 *
 * 1. DIE ÜBERSICHT NENNT IHR OBJEKT ANDERS. Eine Cockpit-Zeile kann jedes Modul
 *    meinen und trägt deshalb `data-object-kind` + `data-object-id` statt
 *    `data-task-id`. Ein Selektor, der nur den zweiten Namen kennt, findet dort
 *    nichts - und der Rückgängig-Streifen sagte fünf Sekunden lang "gelöscht",
 *    während die Zeile stehen blieb und sich anklicken ließ.
 * 2. EINE AUFGABE KANN MEHRFACH DASTEHEN. Auf der Übersicht zugleich im Cockpit
 *    und im Dringend-Widget. `querySelector` nähme die erste und ließe die
 *    andere stehen.
 *
 * Nur die äußersten Treffer: die Aufgabenkarte trägt ihre Id, und die
 * Mehrfachauswahl-Box darin ein zweites Mal.
 */
function taskRowsIn(container, id) {
  if (!container) return [];
  const hits = [...container.querySelectorAll(
    `[data-task-id="${id}"], [data-object-kind="task"][data-object-id="${id}"]`,
  )];
  return hits.filter((el) => !hits.some((other) => other !== el && other.contains(el)));
}

/**
 * Eine Aufgabe löschen, mit Rückgängig-Streifen statt Rückfrage.
 *
 * `container` ist optional und dient allein dem optimistischen Ausblenden: Wer
 * die Zeile im DOM hat - die Liste, das Widget, der Kalendertag -, sieht sie
 * sofort gehen. Wer nicht, sieht sie mit `onChanged` verschwinden.
 */
export async function deleteTaskWithUndo(id, { container = null, onChanged = () => {} } = {}) {
  closeModal({ force: true });
  const rows = taskRowsIn(container, id);
  for (const el of rows) el.style.display = 'none';

  scheduleUndoableDelete({
    message: t('tasks.deletedToast'),
    commit: async ({ keepalive }) => {
      await api.delete(`/tasks/${id}`, { keepalive });
      // Erinnerungen für diese Aufgabe ebenfalls entfernen
      api.delete(`/reminders?entity_type=task&entity_id=${id}`, { keepalive }).catch(() => {});
      if (keepalive) return; // Seite verschwindet — kein UI-Refresh mehr
      refreshReminders();
      await onChanged();
    },
    restore: (err) => {
      for (const el of rows) el.style.display = '';
      if (err) window.yuvomi.showToast(err.message ?? t('common.unknownError'), 'danger');
    },
  });
}

/**
 * Teilaufgabe anlegen - der eine Weg für Liste und Leseansicht.
 *
 * Gibt die angelegte Teilaufgabe zurück (oder null bei Abbruch und Fehler):
 * die Leseansicht hängt sie sich damit selbst an, statt sich zum Nachladen
 * schließen zu müssen (#925).
 */
export async function addSubtask(parentId, { onChanged = () => {} } = {}) {
  const title = await promptModal(t('tasks.subtaskPrompt'));
  if (!title) return null;
  try {
    const res = await api.post('/tasks', { title, parent_task_id: parentId });
    // Wie beim Abhaken daneben: die Umgebung trägt den Fortschrittsbalken der
    // Elternkarte, aber sie muss nichts davon zeigen.
    await onChanged();
    refocusAfterRender();
    return res.data ?? null;
  } catch (err) {
    window.yuvomi.showToast(err.message, 'danger');
    return null;
  }
}

// --------------------------------------------------------
// Bausteine der Leseansicht
// --------------------------------------------------------

// Was aus dem aktuellen Status als Nächstes kommt. Abgelegte Aufgaben führen
// keine Weiterschaltung: sie sind aus dem Lauf genommen, nicht angehalten - ihr
// Knopf holt zurück (siehe openTaskDetail).
const NEXT_STATUS = {
  open:        { status: 'in_progress', labelKey: 'tasks.detailStart',  icon: 'circle-dot' },
  in_progress: { status: 'done',        labelKey: 'tasks.detailFinish', icon: 'check' },
  done:        { status: 'open',        labelKey: 'tasks.detailReopen', icon: 'rotate-ccw' },
};

/** Prioritätsbadge als DOM - dieselbe Optik wie auf der Karte. */
function priorityNode(priority) {
  if (!priority || priority === 'none') return null;
  const badge = document.createElement('span');
  badge.className = 'priority-badge';
  const dot = document.createElement('span');
  dot.className = `priority-dot priority-dot--${priority}`;
  badge.append(dot, document.createTextNode(PRIORITY_LABELS()[priority] ?? priority));
  return badge;
}

/** Eine Chip-Reihe aus einer Liste. Beschriftung liefert der Aufrufer. */
function chipListNode(items, toLabel) {
  if (!items.length) return null;
  const wrap = document.createElement('div');
  wrap.className = 'detail-chips';
  items.forEach((item) => {
    const chip = document.createElement('span');
    chip.className = 'task-tag';
    chip.textContent = toLabel(item);
    wrap.appendChild(chip);
  });
  return wrap;
}

/** Tags als Chips. In der Leseansicht benennen sie, sie filtern nicht. */
function tagChipsNode(tags) {
  return chipListNode(normalizeTagList(tags), (tag) => tag);
}

/** Teilaufgaben mit ihrem Stand - die Liste führt sie, also führt die Ansicht sie auch. */
/**
 * Teilaufgaben in der Detailansicht - abhakbar, nicht nur lesbar (#671).
 *
 * Bis v1.78.0 waren die Zeilen hier reine Anzeige, während dieselbe Teilaufgabe
 * in der Listenkarte einen Schalter hatte. Wer eine Teilaufgabe anlegte und
 * danach die Aufgabe öffnete, sah sie also, kam aber nicht mehr an sie heran -
 * genau die Beobachtung aus der Meldung.
 *
 * Der Klick-Handler des Seiten-Containers greift hier nicht: Die Detailansicht
 * rendert in den Top-Layer, außerhalb von `container`. Deshalb hängt die
 * Delegation am Wrapper selbst.
 *
 * Der Abschnitt bleibt auch leer stehen, solange er etwas anzubieten hat -
 * dieselbe Regel wie bei der Unterhaltung ganz unten, und hier aus einem
 * gemessenen Grund: die Karte blendet ihre Inline-Aktionen unter 640px aus
 * (tasks.css, HIG-Dichte), und der erste Teilschritt hängt genau an dem Knopf,
 * den sie dabei mitnimmt. Der gedachte Ersatzweg war diese Ansicht - nur bot
 * sie den Einstieg nie an, weil sie ohne Teilaufgaben gar nicht erst erschien.
 * Auf dem iPhone gab es damit keinen Weg zur ERSTEN Teilaufgabe, während jede
 * weitere über die aufgeklappte Liste ging (#925).
 */
function subtaskListNode(task, ctx) {
  const mayAdd = canEditTaskDefinition(task, null, ctx) && !isArchived(task) && !task.parent_task_id;
  if (!task.subtasks?.length && !mayAdd) return null;
  const wrap = document.createElement('div');
  wrap.className = 'detail-subtasks';

  const paint = (row, status, title) => {
    row.className = status === 'done' ? 'detail-subtask detail-subtask--done' : 'detail-subtask';
    row.dataset.status = status;
    row.setAttribute('aria-pressed', String(status === 'done'));
    row.setAttribute('aria-label', t('tasks.subtaskMarkDone', { title }));
    const icon = document.createElement('i');
    icon.dataset.lucide = status === 'done' ? 'check-circle-2' : 'circle';
    icon.className = 'icon-sm';
    icon.setAttribute('aria-hidden', 'true');
    const label = document.createElement('span');
    label.textContent = title;
    row.replaceChildren(icon, label);
    if (window.lucide) window.lucide.createIcons({ el: row });
  };

  const appendRow = (s) => {
    const row = document.createElement('button');
    row.type = 'button';
    row.dataset.subtaskId = String(s.id);
    paint(row, s.status, s.title);

    row.addEventListener('click', async () => {
      const previous = row.dataset.status;
      row.disabled = true;
      // Optimistisch umschalten: ein Abhaken, das erst nach der Antwort
      // reagiert, fühlt sich wie ein verschluckter Klick an.
      paint(row, previous === 'done' ? 'open' : 'done', s.title);
      try {
        await toggleSubtaskStatus(s.id, previous);
        // Die Umgebung im Hintergrund trägt den Fortschrittsbalken der
        // Elternkarte - die Liste, das Widget, der Kalendertag.
        await ctx.onChanged();
      } catch (err) {
        paint(row, previous, s.title);
        window.yuvomi.showToast(err.message, 'danger');
      } finally {
        row.disabled = false;
      }
    });

    wrap.appendChild(row);
    return row;
  };

  (task.subtasks ?? []).forEach(appendRow);

  if (mayAdd) {
    const add = document.createElement('button');
    add.type = 'button';
    add.className = 'detail-subtask detail-subtask--add';
    const icon = document.createElement('i');
    icon.dataset.lucide = 'plus';
    icon.className = 'icon-sm';
    icon.setAttribute('aria-hidden', 'true');
    const label = document.createElement('span');
    label.textContent = t('tasks.subtaskAdd');
    add.replaceChildren(icon, label);
    if (window.lucide) window.lucide.createIcons({ el: add });

    add.addEventListener('click', async () => {
      add.disabled = true;
      try {
        // Derselbe Weg wie in der Liste, nicht ein zweiter: addSubtask stellt
        // die Frage, legt an und meldet die Änderung an die Umgebung. Sie gibt
        // die angelegte Teilaufgabe zurück - ohne die müsste diese Ansicht sich
        // schließen, um den neuen Schritt zu zeigen.
        const created = await addSubtask(task.id, ctx);
        if (!created) return;
        task.subtasks = [...(task.subtasks ?? []), created];
        wrap.insertBefore(appendRow(created), add);
      } finally {
        add.disabled = false;
      }
    });

    wrap.appendChild(add);
  }
  return wrap;
}

/**
 * Verknüpfte Dokumente in der Leseansicht (#733).
 *
 * Zwei Korrekturen an einer Stelle: Die alte Fassung las `doc.title` und
 * `doc.filename` - beides Felder, die ein Dokument nie hatte (es heißt `name`
 * bzw. `original_name`), und sie bekam ohnehin nie eine Liste, weil die API das
 * Feld gar nicht füllte. Die Zeile war also doppelt leer.
 *
 * Bilder stehen als Vorschau statt als Wort: an einer Aufgabe hängt meist ein
 * abfotografierter Zettel, und ein Dateiname beantwortet die Frage nicht, wegen
 * der man das Foto angehängt hat. Alles andere bleibt ein Chip mit Link.
 */
function documentListNode(docs) {
  const list = Array.isArray(docs) ? docs : [];
  if (!list.length) return null;

  const images = list.filter((doc) => docMime(doc).startsWith('image/'));
  const rest = list.filter((doc) => !docMime(doc).startsWith('image/'));

  const wrap = document.createElement('div');
  wrap.className = 'task-detail__docs';

  if (images.length) {
    const grid = document.createElement('div');
    grid.className = 'task-detail__doc-previews';
    for (const doc of images) {
      const link = document.createElement('a');
      link.className = 'task-detail__doc-preview';
      link.href = docHref(doc);
      link.target = '_blank';
      link.rel = 'noopener';
      link.title = doc.name || '';
      const img = document.createElement('img');
      img.src = `/api/v1/documents/${doc.id}/preview`;
      img.alt = doc.name || '';
      img.loading = 'lazy';
      link.appendChild(img);
      grid.appendChild(link);
    }
    wrap.appendChild(grid);
  }

  for (const doc of rest) {
    const chip = document.createElement('a');
    chip.className = 'task-doc-chip';
    chip.href = docHref(doc);
    chip.target = '_blank';
    chip.rel = 'noopener';
    const icon = document.createElement('i');
    icon.dataset.lucide = docIcon(doc);
    icon.className = 'task-doc-chip__icon icon-sm';
    icon.setAttribute('aria-hidden', 'true');
    const label = document.createElement('span');
    label.className = 'task-doc-chip__name';
    label.textContent = doc.name || doc.original_name || String(doc.id);
    chip.append(icon, label);
    wrap.appendChild(chip);
  }

  if (window.lucide) window.lucide.createIcons({ el: wrap });
  return wrap;
}

// --------------------------------------------------------
// Kommentare an einer Aufgabe (#734)
//
// „Damit die Absprache dort steht, wo die Sache steht." Der Abschnitt lädt
// selbst nach: die Detailansicht öffnet sofort, die Unterhaltung kommt in dem
// Moment dazu, in dem sie da ist - das ist billiger als ein Ladebalken vor der
// ganzen Ansicht.
// --------------------------------------------------------

/** Kommentartext als DOM, Erwähnungen hervorgehoben. Kein innerHTML nötig. */
function commentTextNode(text, ctx) {
  const box = document.createElement('div');
  box.className = 'task-comment__text';
  for (const segment of splitMentions(text, ctx.users)) {
    if (segment.type !== 'mention') {
      box.appendChild(document.createTextNode(segment.text));
      continue;
    }
    const chip = document.createElement('span');
    // Die eigene Erwähnung sticht heraus: „mich hat jemand gemeint" ist die
    // Information, wegen der man den Kommentar überhaupt liest.
    chip.className = segment.user.id === ctx.currentUserId
      ? 'task-comment__mention task-comment__mention--me'
      : 'task-comment__mention';
    chip.textContent = segment.text;
    box.appendChild(chip);
  }
  return box;
}

/** Eine Zeile der Unterhaltung. */
function commentRowNode(comment, { onChanged, ctx }) {
  const row = document.createElement('article');
  row.className = 'task-comment';

  const head = document.createElement('div');
  head.className = 'task-comment__head';

  const author = document.createElement('span');
  author.className = 'task-comment__author';
  author.textContent = comment.author_name || t('tasks.commentUnknownAuthor');

  const when = document.createElement('span');
  when.className = 'task-comment__when';
  const at = new Date(comment.updated_at || comment.created_at);
  when.textContent = comment.updated_at
    ? t('tasks.commentEditedAt', { date: formatDate(at), time: formatTime(at) })
    : `${formatDate(at)} ${formatTime(at)}`;

  head.append(author, when);

  const mine = comment.user_id === ctx.currentUserId;
  if ((mine || ctx.isAdmin) && !isNavModuleReadOnly('tasks')) {
    const actions = document.createElement('div');
    actions.className = 'task-comment__actions';

    // Ändern darf nur der Autor - ein Admin moderiert, er schreibt nicht um.
    if (mine) {
      const edit = document.createElement('button');
      edit.type = 'button';
      edit.className = 'task-comment__action';
      edit.setAttribute('aria-label', t('tasks.commentEdit'));
      edit.title = t('tasks.commentEdit');
      const editIcon = document.createElement('i');
      editIcon.dataset.lucide = 'pencil';
      editIcon.className = 'icon-sm';
      editIcon.setAttribute('aria-hidden', 'true');
      edit.appendChild(editIcon);
      edit.addEventListener('click', () => startCommentEdit(row, comment, { onChanged, ctx }));
      actions.appendChild(edit);
    }

    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'task-comment__action task-comment__action--danger';
    del.setAttribute('aria-label', t('tasks.commentDelete'));
    del.title = t('tasks.commentDelete');
    const delIcon = document.createElement('i');
    delIcon.dataset.lucide = 'trash-2';
    delIcon.className = 'icon-sm';
    delIcon.setAttribute('aria-hidden', 'true');
    del.appendChild(delIcon);
    // Kein Bestätigungsdialog, sondern der Rückgängig-Toast, den diese Seite
    // schon fürs Löschen einer Aufgabe benutzt. Zwei Gründe: Eine Rückfrage
    // wäre hier ein Modal über einem Modal - `confirmModal` verdrängt die
    // Detailansicht, `confirmOverModal` schließt sie beim Bestätigen (beides
    // gemessen, man stand danach wieder in der Liste). Und ein Kommentar ist
    // kein Datensatz mit Anhängseln: Zurücknehmen ist die ehrlichere Antwort
    // als Vorher-Fragen.
    del.addEventListener('click', () => {
      row.hidden = true;
      scheduleUndoableDelete({
        message: t('tasks.commentDeletedToast'),
        commit: async ({ keepalive }) => {
          await api.delete(`/tasks/${comment.task_id}/comments/${comment.id}`, { keepalive });
          if (keepalive) return; // Seite verschwindet - kein Nachladen mehr
          await onChanged();
        },
        restore: (err) => {
          row.hidden = false;
          if (err) window.yuvomi.showToast(err.message ?? t('common.errorGeneric'), 'danger');
        },
      });
    });
    actions.appendChild(del);
    head.appendChild(actions);
  }

  row.append(head, commentTextNode(comment.comment, ctx));
  return row;
}

/** Eine Zeile gegen ein Eingabefeld tauschen, ohne die Liste neu zu laden. */
function startCommentEdit(row, comment, { onChanged, ctx }) {
  const form = document.createElement('form');
  form.className = 'task-comment__edit';

  const field = document.createElement('textarea');
  field.className = 'input task-comment__input';
  field.rows = 3;
  field.maxLength = 5000;
  field.value = comment.comment;

  const actions = document.createElement('div');
  actions.className = 'task-comment__edit-actions';
  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.className = 'btn btn--ghost btn--sm';
  cancel.textContent = t('common.cancel');
  const save = document.createElement('button');
  save.type = 'submit';
  save.className = 'btn btn--primary btn--sm';
  save.textContent = t('common.save');
  actions.append(cancel, save);

  cancel.addEventListener('click', () => {
    // Die zurueckgeholte Zeile bringt ihre Icons als `data-lucide` mit, nicht
    // als fertiges SVG - ohne diesen Aufruf stuenden Bearbeiten und Loeschen
    // als leere Kaesten da, und zwar bis zum naechsten Nachladen.
    const restored = commentRowNode(comment, { onChanged, ctx });
    row.replaceWith(restored);
    if (window.lucide) window.lucide.createIcons({ el: restored });
  });
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const value = field.value.trim();
    if (!value) return;
    save.disabled = true;
    try {
      await api.patch(`/tasks/${comment.task_id}/comments/${comment.id}`, { comment: value });
      await onChanged();
    } catch (err) {
      save.disabled = false;
      window.yuvomi.showToast(err.message ?? t('common.errorGeneric'), 'danger');
    }
  });

  form.append(field, actions);
  row.replaceChildren(form);
  wireMentionSuggest(field, ctx);
  field.focus();
}

/**
 * Vorschläge beim Tippen eines @.
 *
 * Komfort, keine Bedingung: wer den Namen ausschreibt, wird genauso erwähnt -
 * gelesen wird am Ende der Text, nicht die Auswahl (utils/mentions.js).
 */
function wireMentionSuggest(field, ctx) {
  let box = null;
  let matches = [];
  let active = 0;

  const close = () => { box?.remove(); box = null; matches = []; };

  /** Das angefangene @-Wort links vom Cursor, oder null. */
  const currentQuery = () => {
    const upto = field.value.slice(0, field.selectionStart);
    const at = upto.lastIndexOf('@');
    if (at === -1) return null;
    if (at > 0 && /[\p{L}\p{N}_]/u.test(upto[at - 1])) return null;
    const typed = upto.slice(at + 1);
    // Ein Zeilenumbruch beendet die Suche; ein Leerzeichen darf drin bleiben,
    // weil Anzeigenamen zwei Wörter haben können.
    if (/[\n\r]/.test(typed) || typed.length > 40) return null;
    return { at, typed };
  };

  const apply = (user) => {
    // Die Frage wird hier NOCH EINMAL gestellt, statt sich auf den Stand vom
    // letzten Tastendruck zu verlassen: liegt der Cursor inzwischen woanders,
    // gibt es nichts zu ersetzen, und ein blindes Einfuegen zerschnitte den
    // Text an einer Stelle, die niemand gemeint hat.
    const next = applyMention(field.value, field.selectionStart, user.display_name);
    if (!next) { close(); return; }
    field.value = next.text;
    field.setSelectionRange(next.caret, next.caret);
    close();
    field.focus();
  };

  const render = () => {
    if (!box) {
      box = document.createElement('div');
      box.className = 'task-comment__suggest';
      box.setAttribute('role', 'listbox');
      field.parentElement.appendChild(box);
    }
    box.replaceChildren();
    matches.forEach((user, index) => {
      const option = document.createElement('button');
      option.type = 'button';
      option.className = index === active
        ? 'task-comment__suggest-item is-active'
        : 'task-comment__suggest-item';
      option.setAttribute('role', 'option');
      option.setAttribute('aria-selected', String(index === active));
      option.textContent = user.display_name;
      // mousedown statt click: ein Klick käme erst nach dem blur, und das
      // schließt die Liste, bevor der Treffer übernommen wäre.
      option.addEventListener('mousedown', (e) => { e.preventDefault(); apply(user); });
      box.appendChild(option);
    });
  };

  /** Vorschlaege zur aktuellen Cursorposition neu bestimmen. */
  const sync = () => {
    const query = currentQuery();
    if (!query) { close(); return; }
    const needle = query.typed.toLowerCase();
    matches = ctx.users
      .filter((u) => u.display_name && u.display_name.toLowerCase().startsWith(needle))
      .slice(0, 6);
    active = 0;
    if (!matches.length) { close(); return; }
    render();
  };

  field.addEventListener('input', sync);

  // Der Cursor wandert auch ohne Eingabe - mit Pfeiltasten, per Klick, per
  // Auswahl. Ohne diese beiden Zeilen bliebe die Liste offen, waehrend sie sich
  // laengst auf ein anderes Wort bezieht: Enter fuegte den Namen dann an der
  // NEUEN Position ein (aus „@Ann" mit Cursor hinter dem zweiten Zeichen wurde
  // „@Anna nn"), und am Textanfang verschluckte sie stumm den Zeilenumbruch.
  field.addEventListener('keyup', (e) => {
    if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(e.key)) sync();
  });
  field.addEventListener('click', sync);

  field.addEventListener('keydown', (e) => {
    if (!box || !matches.length) return;
    if (e.key === 'ArrowDown')      { e.preventDefault(); active = (active + 1) % matches.length; render(); }
    else if (e.key === 'ArrowUp')   { e.preventDefault(); active = (active - 1 + matches.length) % matches.length; render(); }
    else if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); apply(matches[active]); }
    else if (e.key === 'Escape')    { e.stopPropagation(); close(); }
  });

  field.addEventListener('blur', () => setTimeout(close, 0));
}

/** Der ganze Abschnitt: Liste, Eingabe, Nachladen. */
function commentsNode(task, ctx) {
  const wrap = document.createElement('div');
  wrap.className = 'task-comments';

  const list = document.createElement('div');
  list.className = 'task-comments__list';
  const status = document.createElement('p');
  status.className = 'task-comments__status';
  status.textContent = t('common.loading');
  list.appendChild(status);

  const load = async () => {
    try {
      const res = await api.get(`/tasks/${task.id}/comments`);
      const comments = res.data ?? [];
      list.replaceChildren();
      if (!comments.length) {
        const empty = document.createElement('p');
        empty.className = 'task-comments__status';
        empty.textContent = t('tasks.commentsEmpty');
        list.appendChild(empty);
      } else {
        for (const comment of comments) list.appendChild(commentRowNode(comment, { onChanged: load, ctx }));
      }
      if (window.lucide) window.lucide.createIcons({ el: list });
    } catch {
      list.replaceChildren();
      const failed = document.createElement('p');
      failed.className = 'task-comments__status';
      failed.textContent = t('tasks.commentsLoadError');
      list.appendChild(failed);
    }
  };

  // Wer die Aufgaben nur LESEN darf, bekommt die Unterhaltung zu sehen und kein
  // Eingabefeld: die API weist seinen POST mit 403 ab, und ein Formular, das
  // zum Schreiben einlaedt und dann nicht abschickt, ist dieselbe leere Zusage
  // wie der fehlende Knopf, der #700 ausgeloest hat.
  if (isNavModuleReadOnly('tasks')) {
    wrap.append(list);
    load();
    return wrap;
  }

  const form = document.createElement('form');
  form.className = 'task-comments__form';
  const field = document.createElement('textarea');
  field.className = 'input task-comment__input';
  field.rows = 2;
  field.maxLength = 5000;
  field.placeholder = t('tasks.commentPlaceholder');
  field.setAttribute('aria-label', t('tasks.commentsLabel'));
  const submit = document.createElement('button');
  submit.type = 'submit';
  // Bewusst nicht `--primary`: der auffälligste Knopf im Panel gehört der
  // Fußzeile („Starten", „Ablegen"). Ein leuchtendes „Kommentieren" mitten im
  // Blatt zöge die Aufmerksamkeit auf die Nebensache.
  submit.className = 'btn btn--secondary btn--sm task-comments__submit';
  submit.textContent = t('tasks.commentSubmit');
  const fieldBox = document.createElement('div');
  // Eigener Träger: die Vorschlagsliste hängt relativ darin, nicht am Formular.
  fieldBox.className = 'task-comments__field';
  fieldBox.appendChild(field);
  form.append(fieldBox, submit);

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const value = field.value.trim();
    if (!value) return;
    submit.disabled = true;
    try {
      await api.post(`/tasks/${task.id}/comments`, { comment: value });
      field.value = '';
      await load();
    } catch (err) {
      window.yuvomi.showToast(err.message ?? t('common.errorGeneric'), 'danger');
    } finally {
      submit.disabled = false;
    }
  });

  wireMentionSuggest(field, ctx);
  wrap.append(list, form);
  load();
  return wrap;
}

/** Erinnerung im Klartext, aus dem gespeicherten Zeitpunkt. */
function taskReminderSummary(reminders) {
  const list = Array.isArray(reminders) ? reminders : (reminders ? [reminders] : []);
  return list
    .map((r) => {
      if (!r?.remind_at) return '';
      const at = parseRemindAtAsUtc(r.remind_at);
      return `${formatDate(at)} ${formatTime(at)}`.trim();
    })
    .filter(Boolean)
    .join(', ');
}

function renderTaskDetail(task, reminders = [], ctx) {
  const due = formatDueDate(task.due_date, task.due_time, task.status === 'done' || isArchived(task));

  return [
    { icon: 'circle-dot', label: t('tasks.statusLabel'), value: STATUS_LABELS()[task.status] ?? task.status },
    // Eigene Zeile statt eines Ersatzes für den Status: die Ablage sagt etwas
    // ANDERES als „offen/erledigt", nicht dasselbe anders (#688).
    { icon: 'archive', label: t('tasks.archivedLabel'), value: isArchived(task) ? formatDate(task.archived_at) : '' },
    { icon: 'flag', label: t('tasks.priorityLabel'), node: priorityNode(task.priority) },
    // Nur wenn gesetzt - eine Zeile "nicht gesperrt" an jeder Aufgabe waere
    // Rauschen. Die leere `value` blendet die Zeile aus (#830).
    { icon: 'lock', label: t('tasks.lockedLabel'), value: task.locked ? t('tasks.lockedDetail') : '' },
    { icon: 'clock', label: t('tasks.dueDateLabel'), value: due?.label ?? '' },
    { icon: 'calendar-clock', label: t('tasks.startDateLabel'), value: task.start_date ? formatDate(task.start_date) : '' },
    recurrenceRow(task.recurrence_rule, { fromCompletion: !!task.recurrence_from_completion }),
    { icon: 'folder', label: t('tasks.categoryLabel'), value: task.category && task.category !== FALLBACK_CATEGORY ? catLabel(task.category, ctx.categories) : '' },
    assignedRow(task.assigned_users, t('tasks.assignedLabel')),
    { icon: 'award', label: t('tasks.pointsLabel'), value: task.points ? String(task.points) : '' },
    { icon: 'tag', label: t('tasks.tagsLabel'), node: tagChipsNode(task.tags) },
    { icon: 'list-checks', label: t('tasks.subtasksLabel'), node: subtaskListNode(task, ctx) },
    { icon: 'paperclip', label: t('tasks.documentsLabel'), node: documentListNode(task.documents) },
    { icon: 'bell', label: t('reminders.sectionTitle'), value: taskReminderSummary(reminders) },
    visibilityRow(task.visibility),
    // Nur wenn markiert (#647) - eine Zeile „Countdown: nein" an jeder Aufgabe
    // erklärte ein Feld, statt eine Frage zu beantworten.
    //
    // UND NUR MIT FÄLLIGKEIT, weil die Zeile sonst etwas Unwahres sagt. Sie hing
    // allein an `task.countdown` und behauptete „Zählt auf der Übersicht
    // herunter" auch dann, wenn es nichts gab, worauf gezählt werden konnte -
    // eine Falschaussage in der Leseansicht wiegt schwerer als der fehlende
    // Riegel im Formular, weil sie den Irrtum bestätigt statt ihn zu verhindern.
    // Der Riegel steht jetzt trotzdem auch dort (`wireCountdownGate`).
    { icon: 'hourglass', label: t('dashboard.countdownTitle'), value: task.countdown && task.due_date ? t('tasks.countdownDetail') : '' },
    { icon: 'align-left', label: t('tasks.descriptionLabel'), node: descriptionNode(task), multiline: true },
    // „Wann war das zuletzt dran" - nur bei wiederkehrenden Aufgaben (#791).
    // Eine einmalige Aufgabe beantwortet die Frage schon mit ihrem Status: sie
    // ist erledigt oder nicht, und ein Verlauf mit genau einer Zeile darin
    // wiederholte nur, was zwei Zeilen weiter oben steht.
    task.is_recurring
      ? { icon: 'history', label: t('tasks.historySeriesTitle'), node: seriesHistoryNode(task), multiline: true }
      : null,
    // Ganz unten und immer sichtbar: die Unterhaltung ist der einzige Abschnitt,
    // der auch dann etwas anbietet, wenn er leer ist - nämlich das Eingabefeld.
    { icon: 'message-square', label: t('tasks.commentsLabel'), node: commentsNode(task, ctx), multiline: true },
  ];
}

/**
 * Die Notiz als gerendertes Markdown (#731).
 *
 * `renderMarkdownLight` liegt seit Langem in utils/html.js und wird von den
 * Notizen und vom Dashboard benutzt - die Aufgaben waren die einzige Stelle, die
 * denselben Freitext als rohen String ausgab. Es ist also kein neuer Baustein,
 * sondern ein nicht angeschlossener; entsprechend teilen sich beide auch die
 * `note-md-*`-Klassen, damit eine Liste hier nicht anders aussieht als dort.
 *
 * Der Renderer maskiert selbst, deshalb ist insertAdjacentHTML hier zulaessig -
 * dieselbe Zusicherung, auf der notes.js und dashboard.js bereits stehen.
 */
function descriptionNode(task) {
  const text = (task.description ?? '').trim();
  if (!text) return null;
  const box = document.createElement('div');
  box.className = 'task-detail__note';
  // Interaktiv, weil diese Ansicht beides kann, was der Renderer dafür
  // verlangt: sie zeigt den VOLLSTÄNDIGEN Text (die Zeilennummern am Kästchen
  // sind also die der Aufgabe) und sie kennt die Aufgaben-Id. Das Dashboard und
  // die Kalender-Chips bekommen diese Optionen deshalb ausdrücklich nicht.
  box.insertAdjacentHTML('beforeend', renderMarkdownLight(text, {
    checklist: { interactive: true, toggleLabel: t('tasks.checklistToggle') },
  }));
  box.addEventListener('click', (e) => {
    const hit = e.target.closest('.note-md-box[data-md-line]');
    if (hit) toggleDescriptionCheck(task, hit);
  });
  return box;
}

/**
 * Einen Haken in der Beschreibung setzen oder lösen (#917).
 *
 * Optimistisch wie bei den Notizen und bei den Teilaufgaben: ein Abhaken, das
 * erst nach der Antwort reagiert, fühlt sich wie ein verschluckter Tap an - und
 * genau auf dem Wandtablett ist das die ganze Interaktion.
 *
 * `expect` ist die Gegenprobe zum Zeilenindex: hat jemand den Text inzwischen
 * bearbeitet, zeigt der Index woanders hin, und ein Haken in der falschen Zeile
 * wäre schlimmer als eine Fehlermeldung. Der Server antwortet dann mit 409.
 *
 * Der lokale Stand wird aus der ANTWORT nachgezogen, nicht selbst gerechnet:
 * sonst liefe `expect` beim zweiten Tap gegen einen Text, den nur der Client
 * kennt.
 */
async function toggleDescriptionCheck(task, box) {
  const line    = parseInt(box.dataset.mdLine, 10);
  const checked = box.dataset.mdChecked !== '1';
  const expect  = splitKeepingLineEndings(task.description)[line * 2];

  // Der eigene Stand kennt die angetippte Zeile gar nicht mehr - dasselbe
  // Ergebnis wie ein 409, nur ohne den Umweg über den Server. Ausdrücklich
  // nicht stilles Nichtstun, sonst täte ein Tap einfach nichts.
  if (expect === undefined) {
    window.yuvomi?.showToast(t('tasks.checkConflict'), 'danger');
    return;
  }

  const paint = (on) => {
    box.setAttribute('aria-checked', String(on));
    box.dataset.mdChecked = on ? '1' : '0';
    box.closest('.note-md-check')?.classList.toggle('is-checked', on);
  };

  paint(checked);
  try {
    const res = await api.patch(`/tasks/${task.id}/check`, { line, checked, expect });
    task.description = res.data.description;
  } catch (err) {
    paint(!checked);
    window.yuvomi?.showToast(
      err.status === 409 ? t('tasks.checkConflict') : (err.data?.error ?? t('common.unknownError')),
      'danger',
    );
  }
}

/**
 * Der eine Einstieg in eine bestehende Aufgabe - fuer jede Ansicht, die eine
 * anbietet (#918).
 *
 * Anders als beim Kalender wird hier bewusst kein Anker übergeben: Eine Aufgabe
 * trägt deutlich mehr Inhalt als ein Termin, und ein 320px-Popover neben der
 * Zeile wäre für Teilaufgaben, Tags und Dokumente zu eng.
 *
 * WAS DIE ANSICHT VON IHRER UMGEBUNG BRAUCHT, STEHT IM AUFRUF. Sie las den
 * Betrachter und die Kategorien früher aus dem `state` der Aufgabenseite und
 * lud diese Seite nach jeder Änderung neu - beides Wissen, das nur dort
 * existiert. Damit war sie an ihr Modul genagelt, und die Übersicht bot
 * stattdessen ein Kärtchen mit zwei Knöpfen an, weil ihr der Rest nicht zur
 * Verfügung stand. Jetzt sagt der Aufrufer, wer schaut (`currentUserId`,
 * `isAdmin`), was er anzeigen kann (`users`, `categories`) und wie er sich
 * selbst auffrischt (`onChanged`) - der Kalender frischt seinen Tag auf, das
 * Widget seine Kachel, die Liste ihre Karten.
 *
 * `edit` ist bewusst injiziert und nicht eingebaut: das Formular gehört dem
 * Aufgabenmodul, nicht der Leseansicht. Wer keinen Mounter mitgibt, bekommt
 * eine Ansicht ohne Bearbeiten-Knopf statt einen, der ins Leere führt.
 *
 * `container` dient allein dazu, die Zeile der Aufgabe beim Löschen sofort
 * auszublenden; wer keinen mitgibt, sieht sie erst nach `onChanged` gehen.
 *
 * @param {{
 *   task: object,
 *   reminder?: object|object[]|null,
 *   users?: object[],
 *   currentUserId?: number|string|null,
 *   isAdmin?: boolean,
 *   categories?: object[],
 *   container?: HTMLElement|null,
 *   onChanged?: () => (void|Promise<void>),
 *   edit?: {mount: (panel: HTMLElement, pane: HTMLElement) => void}|null,
 * }} options
 */
export function openTaskDetail({
  task,
  reminder = null,
  users = [],
  currentUserId = null,
  isAdmin = false,
  categories = [],
  container = null,
  onChanged = () => {},
  edit = null,
}) {
  const ctx = { users, currentUserId, isAdmin, categories, container, onChanged };
  const archived = isArchived(task);
  const next = archived ? null : NEXT_STATUS[task.status];
  // Gesperrte Aufgabe (#830): der Weiterschalt-Knopf bleibt, Loeschen, Ablegen
  // und Bearbeiten fallen weg. Die Detailansicht ist der zweite Einstieg neben
  // der Zeile - blendete nur die Zeile aus, waere die Sperre hier zu umgehen.
  const canEdit = canEditTaskDefinition(task, null, ctx);

  const actions = canEdit ? [{
    id: 'task-detail-delete',
    label: t('common.delete'),
    variant: 'danger-ghost',
    icon: 'trash-2',
    align: 'start',
    // Siehe closeDetailView: nach dem Löschen gibt es nichts mehr zu verwerfen,
    // und der await hält die optimistische Löschung zurück, bis der
    // Overlay-Slot frei ist.
    onClick: async ({ close }) => {
      await close({ force: true });
      deleteTaskWithUndo(String(task.id), ctx);
    },
  }] : [];

  // Der häufigste Grund, eine Aufgabe zu öffnen, ist sie abzuhaken. Bisher
  // führte dieser Weg durch ein Formular mit sieben Auswahlfeldern.
  if (next) {
    actions.push({
      id: 'task-detail-advance',
      label: t(next.labelKey),
      variant: 'secondary',
      icon: next.icon,
      onClick: ({ button }) => advanceTaskStatus(task, next.status, button, ctx),
    });
  }

  // Ablegen und Zurückholen sind derselbe Schalter - was er tut, hängt daran, wo
  // die Aufgabe gerade liegt.
  if (canEdit) {
    actions.push({
      id: 'task-detail-archive',
      label: archived ? t('tasks.unarchiveButton') : t('tasks.archiveButton'),
      variant: 'ghost',
      icon: archived ? 'archive-restore' : 'archive',
      onClick: ({ button }) => toggleTaskArchive(task, button, ctx),
    });
  }

  openDetailView({
    title: task.title,
    size: 'lg',
    sections: renderTaskDetail(task, reminder, ctx),
    actions,
    edit: canEdit && edit ? {
      label: t('common.edit'),
      title: t('tasks.editTask'),
      mount: (panel, pane) => edit.mount(panel, pane),
    } : undefined,
  });
}

/**
 * Status aus der Detailansicht weiterschalten. Optimistisch: Der Knopf zeigt
 * den neuen Stand sofort, weil das Abhaken sonst wie ein verschluckter Klick
 * wirkt. Scheitert der Aufruf, kommt die alte Beschriftung zurück.
 */
async function advanceTaskStatus(task, status, button, ctx) {
  const previous = task.status;
  const stop = btnLoading(button);
  try {
    await api.patch(`/tasks/${task.id}/status`, { status });
    task.status = status;
    // Der Status steht bereits beim Server - eine Verwerfen-Frage danach böte
    // an, etwas rückgängig zu machen, was gar nicht mehr aussteht (#625).
    await closeDetailView({ force: true });
    await ctx.onChanged();
    refocusAfterRender();
  } catch (err) {
    task.status = previous;
    stop();
    // Gescheitert ist ein Schreibvorgang, kein Laden - tasks.loadError („Aufgabe
    // konnte nicht geladen werden") beschriebe den falschen Vorgang.
    window.yuvomi.showToast(err.message ?? t('common.errorGeneric'), 'danger');
  }
}

/**
 * Ablegen bzw. Zurückholen aus der Detailansicht. Wie advanceTaskStatus schließt
 * die Ansicht danach: die Aufgabe wechselt die Liste, und ein Panel, das über
 * einem verschwundenen Eintrag stehen bleibt, hat nichts mehr zu zeigen.
 */
async function toggleTaskArchive(task, button, ctx) {
  const stop = btnLoading(button);
  const archived = isArchived(task);
  try {
    await setTaskArchived(task.id, !archived);
    task.archived_at = archived ? null : new Date().toISOString();
    await closeDetailView({ force: true });
    window.yuvomi.showToast(archived ? t('tasks.unarchivedToast') : t('tasks.archivedToast'), 'success');
    await ctx.onChanged();
    refocusAfterRender();
  } catch (err) {
    stop();
    window.yuvomi.showToast(err.message ?? t('common.errorGeneric'), 'danger');
  }
}

/**
 * „Zuletzt erledigt" für die Detailansicht - über die ganze Wiederholungskette,
 * nicht nur für die Instanz, die gerade offen daliegt.
 *
 * Nachgeladen statt mitgeliefert: die Aufgabenliste holt Dutzende Zeilen, und
 * eine Historie an jeder davon wäre Ladearbeit für eine Zeile, die man erst
 * beim Öffnen sieht.
 */
function seriesHistoryNode(task) {
  // Ohne eigene Ueberschrift: die Detailzeile traegt ihr Label schon, und eine
  // zweite daneben saehe aus wie ein zweiter Abschnitt.
  const list = document.createElement('div');
  list.className = 'detail-history';
  const placeholder = document.createElement('p');
  placeholder.className = 'detail-history__empty';
  placeholder.textContent = t('common.loading');
  list.appendChild(placeholder);

  api.get(`/tasks/${task.id}/completions?limit=10`).then((res) => {
    const entries = res.data ?? [];
    list.replaceChildren();
    if (!entries.length) {
      const none = document.createElement('p');
      none.className = 'detail-history__empty';
      none.textContent = t('tasks.historySeriesEmpty');
      list.appendChild(none);
      return;
    }
    for (const entry of entries) {
      const row = document.createElement('p');
      row.className = 'detail-history__row';
      const when = document.createElement('span');
      when.className = 'detail-history__when';
      when.textContent = `${historyDayLabel(zonedDateKey(entry.completed_at))}, ${formatTime(entry.completed_at)}`;
      const who = document.createElement('span');
      who.className = 'detail-history__who';
      who.textContent = entry.user_name || t('tasks.historyUnknownMember');
      row.append(when, who);
      list.appendChild(row);
    }
  }).catch(() => {
    list.replaceChildren();
    const failed = document.createElement('p');
    failed.className = 'detail-history__empty';
    failed.textContent = t('tasks.historySeriesLoadError');
    list.appendChild(failed);
  });

  return list;
}
