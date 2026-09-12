/**
 * Modul: Pinnwand / Notizen (Notes)
 * Zweck: Masonry-Grid mit farbigen Sticky Notes, Pin-Toggle, CRUD
 * Abhängigkeiten: /api.js, /router.js (window.yuvomi)
 */

import { api } from '/api.js';
import { openModal as openSharedModal, closeModal, btnError, advancedSection, reportFieldError } from '/components/modal.js';
import { wireCategoryScopeHelp } from '/components/category-manager.js';
import { stagger, vibrate, scheduleUndoableDelete, wireScrollFade } from '/utils/ux.js';
import { t } from '/i18n.js';
import { esc, renderMarkdownLight } from '/utils/html.js';
import { splitKeepingLineEndings } from '/utils/markdown-checklist.js';
import { renderMarkdownToolbar, wireMarkdownToolbar } from '/utils/markdown-toolbar.js';
import { renderSkeletonList } from '/utils/skeleton.js';
import { renderPageSearch, wirePageSearch } from '/utils/page-search.js';
import { findPageFab } from '/utils/fab.js';
import { emptyStateHTML } from '/utils/empty-state.js';
import { AVATAR_FALLBACK_COLOR } from '/utils/color.js';
import {
  noteMatchesCategories,
  occupiedNoteCategoryIds,
  pruneMissingNoteCategoryIds,
  removeNoteCategoryFromState,
} from '/utils/note-category-filter.js';
import {
  categoryCreationState,
  closeCategoryPicker,
  findCategorySuggestions,
  findExactCategory,
  moveCategoryPickerOption,
} from '/utils/note-category-picker.js';

// --------------------------------------------------------
// Konstanten
// --------------------------------------------------------

// Gedämpfte Sticker-Palette. Die frühere Material-Primär-Palette
// (#FFEB3B/#80DEEA/#CE93D8 …) las wie eine billigere App (Critique P3).
// Seit dem HIG-Rollout tragen diese Werte die Karte nicht mehr als Vollfläche,
// sondern nur noch als 16-%-Tönung darauf (siehe .note-card in notes.css) -
// die Lesbarkeit hängt damit an keiner dieser Farben mehr, auch nicht an
// Alt-Hex-Werten ausserhalb der Palette. Die Palette bleibt trotzdem gedämpft:
// bei 16 % soll sie eine leise Ordnungshilfe sein, kein Signal.
const NOTE_COLORS = [
  '#EFE3BE', '#E7D2A9', '#D2DEC6', '#C7DED9',
  '#CAD8E4', '#D8D0E2', '#EBD1C2', '#FBFAF7',
];

const NOTE_COLOR_NAMES = () => ({
  '#EFE3BE': t('notes.colorYellow'),
  '#E7D2A9': t('notes.colorAmber'),
  '#D2DEC6': t('notes.colorGreen'),
  '#C7DED9': t('notes.colorTeal'),
  '#CAD8E4': t('notes.colorBlue'),
  '#D8D0E2': t('notes.colorPurple'),
  '#EBD1C2': t('notes.colorOrange'),
  '#FBFAF7': t('notes.colorWhite'),
});

// --------------------------------------------------------
// State
// --------------------------------------------------------

let state = {
  notes: [],
  categories: [],
  canManageHousehold: false,
  user: null,
  filterQuery: '',
  filterCreator: '',
  filterCategoryIds: [],
};
let _container = null;

// --------------------------------------------------------
// Antippbare Checklisten (#704)
// --------------------------------------------------------

// Die Notizen sind die eine Stelle, die einen Haken auch zurueckschreiben kann:
// sie zeigen den vollstaendigen Text und kennen die Notiz-ID. Das Dashboard
// bekommt diese Optionen deshalb ausdruecklich nicht - dort steht ein gekuerzter
// Auszug, dessen Zeilennummern nicht die der Notiz sind.
const CHECKLIST_OPTS = () => ({
  checklist: { interactive: true, toggleLabel: t('notes.checklistToggle') },
});

/**
 * Zeichnet einen umgeschalteten Haken in jede Ansicht, die ihn gerade zeigt.
 *
 * Bewusst kein `renderGrid()`: das baute das ganze Raster neu, mit Einblend-
 * Staffelung und verlorenem Fokus - fuer einen Haken. Und da `state.notes` nicht
 * umsortiert wird, springt die Notiz auch nicht unter dem Finger weg; die neue
 * Reihenfolge greift beim naechsten vollen Laden.
 */
function paintCheck(noteId, line, checked) {
  const roots = [
    _container?.querySelector(`.note-card[data-id="${noteId}"] .note-card__content`),
    document.querySelector(`.note-modal[data-note-id="${noteId}"] .note-read__body`),
  ];
  for (const root of roots) {
    const box = root?.querySelector(`.note-md-box[data-md-line="${line}"]`);
    if (!box) continue;
    box.setAttribute('aria-checked', String(checked));
    box.dataset.mdChecked = checked ? '1' : '0';
    box.closest('.note-md-check')?.classList.toggle('is-checked', checked);
  }
}

/**
 * Haken setzen oder loesen.
 *
 * Optimistisch: der Haken erscheint sofort, denn auf dem Wandtablett ist das
 * die ganze Interaktion, und eine Verzoegerung dort laesst sie kaputt aussehen.
 * Schlaegt die Anfrage fehl, geht er zurueck - inklusive des Falls, dass
 * jemand anders den Text inzwischen bearbeitet hat (409). Dann wird neu
 * geladen, statt einen Haken zu behaupten, den der Server nicht kennt.
 */
async function toggleCheck(noteId, box) {
  const note = state.notes.find((n) => n.id === noteId);
  if (!note) return;

  const line    = parseInt(box.dataset.mdLine, 10);
  const checked = box.dataset.mdChecked !== '1';
  // Die Zeile, die der Nutzer gesehen hat - sie ist die Gegenprobe zum Index.
  const expect  = splitKeepingLineEndings(note.content)[line * 2];

  // Der eigene Stand kennt die angetippte Zeile gar nicht mehr: dasselbe
  // Ergebnis wie ein 409, nur ohne den Umweg ueber den Server - und
  // ausdruecklich nicht stilles Nichtstun, sonst taete ein Tap einfach nichts.
  if (expect === undefined) {
    await handleCheckConflict();
    return;
  }

  paintCheck(noteId, line, checked);
  vibrate(10);

  try {
    const res = await api.patch(`/notes/${noteId}/check`, { line, checked, expect });
    note.content = res.data.content;
    note.updated_at = res.data.updated_at;
  } catch (err) {
    paintCheck(noteId, line, !checked);
    if (err.status === 409) {
      await handleCheckConflict();
    } else {
      window.yuvomi?.showToast(err.data?.error ?? t('common.unknownError'), 'danger');
    }
  }
}

async function handleCheckConflict() {
  window.yuvomi?.showToast(t('notes.checkConflict'), 'danger');
  await reloadNotes();
}

// --------------------------------------------------------
// Entry Point
// --------------------------------------------------------

export async function render(container, { user, signal }) {
  if (signal?.aborted) return;
  _container = container;
  state.user = user;

  container.replaceChildren();
  // Modus `full`, nicht `reading`: das Masonry-Raster reflowt nach seinem
  // EIGENEN Platz (bis fuenf Spalten ab 1200px Container, notes.css) und ist
  // die Seite. Ein Lesemass wuerde entweder den Kopf bei 720px enden lassen,
  // waehrend das Raster daneben weiterlaeuft, oder das Raster auf zwei bis drei
  // Spalten stutzen. Kopf und Koerper enden deshalb beide an der Nutzbreite.
  container.insertAdjacentHTML('beforeend', `
    <div class="notes-page app-page app-page--full" data-composition="full">
      <div class="page-toolbar notes-toolbar">
        <h1 class="page-toolbar__title">${t('notes.title')}</h1>
        ${renderPageSearch({ id: 'notes-search', label: t('notes.searchPlaceholder'), placeholder: t('notes.searchPlaceholder'), value: state.filterQuery, clearLabel: t('common.searchClear'), className: 'notes-toolbar__search' })}
        <button class="btn btn--secondary notes-manage-categories" id="notes-manage-categories" aria-label="${t('category.manageTitle')}">
          <i data-lucide="tags" class="icon-md" aria-hidden="true"></i>
          <span>${t('noteCategories.categories')}</span>
        </button>
        <button class="btn btn--primary toolbar-new-btn" id="notes-add-btn" aria-label="${t('notes.addNoteLabel')}">
          <i data-lucide="plus" class="icon-md" aria-hidden="true"></i>
          <span class="toolbar-new-btn__label">${t('newLabel.notes')}</span>
        </button>
      </div>
      <div class="notes-filters" id="notes-filters" hidden></div>
      <div class="notes-scroll page-scrollport">
        <div id="notes-grid" class="notes-grid" aria-busy="true">${renderSkeletonList({ rows: 5, lines: 3 })}</div>
      </div>
      <button class="page-fab" id="fab-new-note" aria-label="${t('notes.addNoteLabel')}" data-dock-label="${t('newLabel.notes')}">
        <i data-lucide="plus" class="icon-xl" aria-hidden="true"></i>
      </button>
    </div>
  `);

  if (window.lucide) lucide.createIcons({ el: container });

  try {
    const [notesRes, categoriesRes] = await Promise.all([api.get('/notes'), api.get('/notes/categories')]);
    if (signal?.aborted || _container !== container) return;
    state.notes = notesRes.data;
    state.categories = categoriesRes.data || [];
    state.filterCategoryIds = pruneMissingNoteCategoryIds(state.filterCategoryIds, state.categories);
    state.canManageHousehold = !!categoriesRes.meta?.can_manage_household;
  } catch (err) {
    console.error('[Notes] Laden fehlgeschlagen:', err);
    throw err;
  }
  const grid = container.querySelector('#notes-grid');
  grid.addEventListener('click', async (e) => {
    const pinBtn = e.target.closest('[data-action="pin"]');
    if (pinBtn) { e.stopPropagation(); await togglePin(parseInt(pinBtn.dataset.id, 10)); return; }

    const delBtn = e.target.closest('[data-action="delete"]');
    if (delBtn) { e.stopPropagation(); await deleteNote(parseInt(delBtn.dataset.id, 10)); return; }

    // Ein Haken auf der Karte darf die Notiz nicht oeffnen (#704) - sonst
    // schluege der Zettel bei jedem Abhaken auf, und genau die drei Schritte
    // sollten ja wegfallen.
    const box = e.target.closest('.note-md-box[data-md-line]');
    if (box) {
      e.stopPropagation();
      const owner = box.closest('.note-card[data-id]');
      if (owner) await toggleCheck(parseInt(owner.dataset.id, 10), box);
      return;
    }

    // [data-action="open"] fällt bewusst durch auf den Karten-Zweig darunter —
    // der Button liegt in der Karte, ein Treffer reicht.
    const card = e.target.closest('.note-card[data-id]');
    if (card) {
      const note = state.notes.find((n) => n.id === parseInt(card.dataset.id, 10));
      if (note) openNoteModal({ mode: 'edit', note });
    }
  });

  renderNotesAndFilters();

  const filterFade = wireScrollFade(container.querySelector('#notes-filters'));
  signal?.addEventListener('abort', () => filterFade.destroy(), { once: true });

  const addHandler = () => openNoteModal({ mode: 'create' });
  // #notes-add-btn ist per .toolbar-new-btn global ausgeblendet (FAB übernimmt),
  // bleibt aber als einheitliches Modul-Muster erhalten (frontend-audit 1.9).
  _container.querySelector('#notes-add-btn').addEventListener('click', addHandler);
  _container.querySelector('#notes-manage-categories').addEventListener('click', openNoteCategoryManager);
  findPageFab('fab-new-note').addEventListener('click', addHandler);

  wirePageSearch(_container, {
    id: 'notes-search',
    delay: 0,
    onQuery: (value) => {
      state.filterQuery = value;
      renderGrid();
    },
  });
}

// --------------------------------------------------------
// Grid
// --------------------------------------------------------

/** Kategorienchips haengen von den Zuordnungen in state.notes ab. */
function renderNotesAndFilters() {
  renderFilters();
  renderGrid();
}

/**
 * Ersteller-Filterzeile. Erst ab zwei Autorinnen/Autoren sinnvoll — in einem
 * Ein-Personen-Haushalt wäre sie ein Chip ohne Alternative. Nutzt dieselben
 * Button-Chips wie Dokumente/Aufgaben (Tastatur + aria-pressed).
 */
function renderFilters() {
  const row = _container.querySelector('#notes-filters');
  if (!row) return;

  const creators = [...new Map(
    state.notes
      .filter((n) => n.creator_name)
      .map((n) => [n.creator_name, n])
  ).values()];

  const assignedCategoryIds = occupiedNoteCategoryIds(state.notes);
  const filterCategories = state.categories.filter((category) => (
    assignedCategoryIds.has(Number(category.id))
    || state.filterCategoryIds.includes(Number(category.id))
  ));

  row.hidden = creators.length < 2 && filterCategories.length === 0;
  const focused = row.contains(document.activeElement) ? document.activeElement : null;
  const focusKey = ['creator', 'categoryId', 'clearCategories'].find((key) => focused && Object.hasOwn(focused.dataset, key));
  const focusValue = focusKey ? focused.dataset[focusKey] : null;
  const scrollLeft = row.scrollLeft;
  row.replaceChildren();
  if (row.hidden) return;

  const makeChip = (label, value) => {
    const active = state.filterCreator === value;
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = `filter-chip filter-chip--sm${active ? ' filter-chip--active' : ''}`;
    chip.dataset.creator = value;
    chip.setAttribute('aria-pressed', String(active));
    chip.textContent = label;
    return chip;
  };

  if (creators.length >= 2) {
    const group = document.createElement('div');
    group.className = 'notes-filter-group';
    group.setAttribute('role', 'group');
    group.setAttribute('aria-label', t('notes.filterCreatorLabel'));
    group.appendChild(makeChip(t('common.all'), ''));
    creators.forEach((n) => group.appendChild(makeChip(n.creator_name, n.creator_name)));
    row.appendChild(group);
  }

  if (filterCategories.length) {
    const group = document.createElement('div');
    group.className = 'notes-filter-group notes-filter-group--categories';
    group.setAttribute('role', 'group');
    group.setAttribute('aria-label', t('noteCategories.filterLabel'));
    const clear = document.createElement('button');
    clear.type = 'button';
    clear.className = `filter-chip filter-chip--sm${state.filterCategoryIds.length ? '' : ' filter-chip--active'}`;
    clear.dataset.clearCategories = '';
    clear.setAttribute('aria-pressed', String(state.filterCategoryIds.length === 0));
    clear.textContent = t('common.all');
    group.appendChild(clear);
    for (const category of filterCategories) {
      const active = state.filterCategoryIds.includes(Number(category.id));
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = `filter-chip filter-chip--sm${active ? ' filter-chip--active' : ''}`;
      chip.dataset.categoryId = String(category.id);
      chip.setAttribute('aria-pressed', String(active));
      chip.insertAdjacentHTML('beforeend', `<i data-lucide="${category.scope === 'personal' ? 'user' : 'home'}" class="icon-sm" aria-hidden="true"></i>${esc(category.name)}<span class="sr-only"> (${esc(categoryScopeLabel(category))})</span>`);
      group.appendChild(chip);
    }
    row.appendChild(group);
  }

  row.querySelectorAll('[data-creator]').forEach((chip) => {
    chip.addEventListener('click', () => {
      // Erneuter Klick auf den aktiven Chip hebt den Filter auf.
      state.filterCreator = state.filterCreator === chip.dataset.creator ? '' : chip.dataset.creator;
      renderNotesAndFilters();
    });
  });
  row.querySelectorAll('[data-category-id]').forEach((chip) => {
    chip.addEventListener('click', () => {
      const id = Number(chip.dataset.categoryId);
      state.filterCategoryIds = state.filterCategoryIds.includes(id)
        ? state.filterCategoryIds.filter((item) => item !== id)
        : [...state.filterCategoryIds, id];
      renderNotesAndFilters();
    });
  });
  row.querySelector('[data-clear-categories]')?.addEventListener('click', () => {
    state.filterCategoryIds = [];
    renderNotesAndFilters();
  });
  window.lucide?.createIcons({ el: row });
  if (focusKey) {
    [...row.querySelectorAll('button')].find((chip) => chip.dataset[focusKey] === focusValue)?.focus({ preventScroll: true });
  }
  row.scrollLeft = scrollLeft;
}

function visibleNotes() {
  const q = state.filterQuery.trim().toLowerCase();
  return state.notes.filter((n) => {
    if (state.filterCreator && n.creator_name !== state.filterCreator) return false;
    if (!noteMatchesCategories(n, state.filterCategoryIds)) return false;
    if (!q) return true;
    return (n.title   || '').toLowerCase().includes(q)
        || (n.content || '').toLowerCase().includes(q);
  });
}

function renderGrid() {
  const grid = _container.querySelector('#notes-grid');
  if (!grid) return;
  grid.removeAttribute('aria-busy');

  const q = state.filterQuery.trim().toLowerCase();
  const visible = visibleNotes();

  if (!visible.length) {
    const isFiltered = q.length > 0 || !!state.filterCreator || state.filterCategoryIds.length > 0;
    grid.replaceChildren();
    // Gefiltert ohne Treffer ist ein anderer Zustand als „noch keine Notiz":
    // er wird als `role="status"` angesagt und traegt keinen Anlegen-CTA.
    grid.insertAdjacentHTML('beforeend', isFiltered
      ? emptyStateHTML({
        variant: 'no-results',
        title: t('notes.noResultsTitle'),
        description: q
          ? t('notes.noResultsDescription', { query: state.filterQuery })
          : state.filterCategoryIds.length
            ? t('noteCategories.noResults')
            : t('notes.noResultsCreatorDescription', { name: state.filterCreator }),
      })
      : emptyStateHTML({
        icon: 'file-text',
        title: t('notes.emptyTitle'),
        description: t('notes.emptyDescription'),
        hint: t('emptyHint.notes'),
        action: { label: t('notes.emptyAction'), icon: 'plus', attrs: { id: 'empty-cta-notes' } },
      }));
    if (window.lucide) lucide.createIcons({ el: grid });
    grid.querySelector('#empty-cta-notes')?.addEventListener('click', () => {
      document.querySelector('.page-fab')?.click();
    });
    return;
  }

  // Angepinnte Notizen standen schon immer vorn, aber ohne sichtbare Grenze:
  // die Trennung war nur aus dem Ring an der Karte zu erschließen. Zwei
  // Abschnittsköpfe machen die bestehende Sortierung lesbar. Sie erscheinen
  // nur, wenn es tatsächlich beide Gruppen gibt.
  const pinned = visible.filter((n) => n.pinned);
  const rest   = visible.filter((n) => !n.pinned);
  const heading = (label) => `<h2 class="notes-group__title u-section-title">${label}</h2>`;

  const html = (pinned.length && rest.length)
    ? heading(t('notes.groupPinned')) + pinned.map(renderNoteCard).join('')
      + heading(t('notes.groupOthers')) + rest.map(renderNoteCard).join('')
    : visible.map(renderNoteCard).join('');

  grid.replaceChildren();
  grid.insertAdjacentHTML('beforeend', html);
  if (window.lucide) lucide.createIcons({ el: grid });
  stagger(grid.querySelectorAll('.note-card'));
}

function renderNoteCard(note) {
  // KEINE INITIALEN AUF EINER 16px-SCHEIBE (Initialen-Schwelle-Regel).
  //
  // Hier standen bis zuletzt zwei Buchstaben auf einer 16-%-Waschung - unter der
  // 20px-Schwelle, ab der die Regel Text überhaupt erlaubt, und direkt neben dem
  // ausgeschriebenen Namen, den sie abkürzten. Die Scheibe trägt ihre Identität
  // jetzt so, wie die Regel es vorsieht: als Farbe allein, im Vollton. Der Name
  // steht unverändert daneben, es geht also nichts verloren.
  //
  // Die Zettelfarbe darüber bleibt beim gemessenen 16-%-Rezept - sie ist eine
  // ganze Inhaltsfläche, und für die gilt die User-Farben-Regel weiter.
  const avatarColor = note.creator_color || AVATAR_FALLBACK_COLOR;

  return `
    <div class="note-card ${note.pinned ? 'note-card--pinned' : ''}"
         data-id="${note.id}"
         style="--note-color:${esc(note.color)};">
      <button class="note-card__pin" data-action="pin" data-id="${note.id}"
              aria-label="${note.pinned ? t('notes.unpinAction') : t('notes.pinAction')}">
        <i data-lucide="${note.pinned ? 'pin-off' : 'pin'}" class="icon-sm" aria-hidden="true"></i>
      </button>
      ${note.title ? `<div class="note-card__title">${esc(note.title)}</div>` : ''}
      <div class="note-card__content">${renderMarkdownLight(note.content, CHECKLIST_OPTS())}</div>
      ${(note.categories || []).length ? `<div class="note-card__categories" role="group" aria-label="${t('noteCategories.categories')}">
        ${note.categories.map(renderCategoryBadge).join('')}
      </div>` : ''}
      <div class="note-card__footer">
        <div class="note-card__creator">
          <span class="note-card__avatar"
                style="--avatar-color:${esc(avatarColor)};">
            ${note.creator_avatar
              ? `<img src="${esc(note.creator_avatar)}" alt="${esc(note.creator_name || '')}" loading="lazy">`
              : ''}
          </span>
          <span>${esc(note.creator_name || '')}</span>
        </div>
        <div class="note-card__actions">
          <!-- Die Karte selbst ist ein Div mit Klick-Handler und daher nicht
               fokussierbar. Ohne diesen Button gäbe es für Tastatur- und
               Screenreader-Nutzung keinen Weg, eine Notiz zu öffnen. Analog zur
               Inline-Aktion auf der Aufgaben-Karte. -->
          <button class="note-card__open" data-action="open" data-id="${note.id}"
                  aria-label="${t('notes.openNote')}">
            <i data-lucide="maximize-2" class="icon-sm" aria-hidden="true"></i>
          </button>
          <button class="note-card__delete" data-action="delete" data-id="${note.id}" aria-label="${t('notes.deleteLabel')}">
            <i data-lucide="trash-2" class="icon-sm" aria-hidden="true"></i>
          </button>
        </div>
      </div>
    </div>
  `;
}

// --------------------------------------------------------
// Modal
// --------------------------------------------------------

// Gerenderte Markdown-Leseansicht (Reader-Modus, Discussion #507). Nutzt den
// gemeinsamen renderMarkdownLight-Renderer. Der Notiztitel trägt der Modal-Header
// (Recognition), daher hier nur der Inhalt.
/**
 * @param {string} content Der anzuzeigende Text
 * @param {{ live?: boolean }} [opts] Sind die Kaestchen bedienbar? Nur wahr,
 *   wenn der gezeigte Text dem gespeicherten entspricht - der Lesemodus
 *   spiegelt sonst ungespeicherte Aenderungen, und dann zeigen seine
 *   Zeilennummern auf einen Text, den der Server noch nicht kennt (#704).
 */
function categoryScopeLabel(category) {
  return t(category.scope === 'personal' ? 'noteCategories.personal' : 'noteCategories.household');
}

function renderCategoryBadge(category) {
  return `<span class="note-category-badge note-category-badge--${category.scope} u-badge">
    <i data-lucide="${category.scope === 'personal' ? 'user' : 'home'}" aria-hidden="true"></i><span class="note-category-badge__name">${esc(category.name)}</span>
    <span class="sr-only"> (${esc(categoryScopeLabel(category))})</span>
  </span>`;
}

function renderNoteReadHtml(content, { live = false, categories = [] } = {}) {
  const body = (content || '').trim()
    ? renderMarkdownLight(content, live ? CHECKLIST_OPTS() : {})
    : `<p class="note-read__empty">${t('notes.readEmpty')}</p>`;
  return `${categories.length ? `<div class="note-read__categories" role="group" aria-label="${t('noteCategories.categories')}">
    ${categories.map(renderCategoryBadge).join('')}
  </div>` : ''}<div class="note-read__body">${body}</div>`;
}

function assignableCategories() {
  // The API already returns only the current user's personal categories plus
  // the shared household catalog. Managing that catalog is permission-gated;
  // using an existing household category is intentionally available to all.
  return state.categories;
}

function renderSelectedCategory(category) {
  return `<span class="note-category-selection" data-selected-category-id="${category.id}">
    <input type="checkbox" name="note-category" value="${category.id}" checked hidden>
    <i data-lucide="${category.scope === 'personal' ? 'user' : 'home'}" aria-hidden="true"></i>
    <span class="note-category-selection__name">${esc(category.name)}</span>
    <button type="button" class="note-category-selection__remove" data-category-remove="${category.id}"
            aria-label="${esc(t('noteCategories.removeAction', { name: category.name }))}">
      <i data-lucide="x" aria-hidden="true"></i>
    </button>
  </span>`;
}

function renderSelectedCategories(selectedIds) {
  const selected = new Set(selectedIds.map(Number));
  return assignableCategories()
    .filter((category) => selected.has(Number(category.id)))
    .map(renderSelectedCategory)
    .join('');
}

function renderCategoryScopeControl() {
  if (!state.canManageHousehold) return '';
  return `<div class="note-category-editor__scope">
    <select class="form-input" id="note-category-new-scope" aria-label="${esc(t('noteCategories.scopeLabel'))}"
            aria-describedby="note-category-scope-help">
      <option value="personal">${t('noteCategories.personal')}</option>
      <option value="household">${t('noteCategories.household')}</option>
    </select>
    <button type="button" class="category-scope-help" aria-expanded="false" aria-label="${esc(t('noteCategories.scopeHelp'))}">
      <i data-lucide="info" aria-hidden="true"></i>
      <span class="category-scope-help__tooltip u-meta" id="note-category-scope-help" role="tooltip">${esc(t('noteCategories.scopeHelp'))}</span>
    </button>
  </div>`;
}

function renderCategoryEditor(selectedIds = []) {
  return `
    <div class="form-group note-category-editor">
      <label class="form-label" for="note-category-search">${t('noteCategories.categories')}</label>
      <div class="note-category-editor__choices" id="note-category-choices">
        ${renderSelectedCategories(selectedIds)}
      </div>
      <div class="note-category-picker">
        <div class="note-category-picker__combobox">
          <input type="text" class="form-input" id="note-category-search" maxlength="80"
                 placeholder="${esc(t('noteCategories.searchPlaceholder'))}" role="combobox"
                 aria-autocomplete="list" aria-expanded="false" aria-controls="note-category-suggestions"
                 autocomplete="off">
          <div class="note-category-picker__list" id="note-category-suggestions" role="listbox"
               aria-label="${esc(t('noteCategories.searchResultsLabel'))}" hidden></div>
        </div>
        <div class="note-category-editor__create" id="note-category-create-row"${state.canManageHousehold ? '' : ' hidden'}>
          ${renderCategoryScopeControl()}
          <button type="button" class="btn btn--secondary" id="note-category-create" hidden></button>
        </div>
      </div>
    </div>`;
}

function openNoteModal({ mode, note = null }) {
  const isEdit      = mode === 'edit';
  const selColor    = (isEdit ? note.color : null) || NOTE_COLORS[0];
  // Bestehende Notizen können Farben außerhalb der Palette tragen (Alt-Daten,
  // frühere Paletten). Die aktuelle Farbe wird dann als eigener Swatch
  // vorangestellt: sonst wäre nichts selektiert und die Radio-Gruppe hätte
  // keinen Tastatur-Einstieg (kein tabindex="0" im Roving-Muster).
  const swatchColors = NOTE_COLORS.includes(selColor) ? NOTE_COLORS : [selColor, ...NOTE_COLORS];
  // Bestehende Notizen öffnen im Lese-Modus (#507); neue direkt im Editor.
  const initialView = isEdit ? 'read' : 'edit';
  let editorClosed = false;

  const content = `
    <div class="note-modal" data-view="${initialView}"${isEdit ? ` data-note-id="${note.id}"` : ''} style="--note-color:${esc(selColor)};">
      <div class="note-mode-switch" role="tablist" aria-label="${t('notes.modeSwitchLabel')}">
        <button type="button" id="note-tab-read" class="sub-tab${initialView === 'read' ? ' sub-tab--active' : ''}"
                role="tab" aria-selected="${initialView === 'read' ? 'true' : 'false'}"
                aria-controls="note-pane-read" tabindex="${initialView === 'read' ? '0' : '-1'}" data-view="read">
          <i data-lucide="book-open" class="sub-tab__icon" aria-hidden="true"></i>
          <span class="sub-tab__label">${t('notes.modeRead')}</span>
        </button>
        <button type="button" id="note-tab-edit" class="sub-tab${initialView === 'edit' ? ' sub-tab--active' : ''}"
                role="tab" aria-selected="${initialView === 'edit' ? 'true' : 'false'}"
                aria-controls="note-pane-edit" tabindex="${initialView === 'edit' ? '0' : '-1'}" data-view="edit">
          <i data-lucide="pencil" class="sub-tab__icon" aria-hidden="true"></i>
          <span class="sub-tab__label">${t('notes.modeEdit')}</span>
        </button>
      </div>

      <div class="note-read-view" id="note-pane-read" data-pane="read" role="tabpanel"
           aria-labelledby="note-tab-read" tabindex="-1"${initialView === 'read' ? '' : ' hidden'}>
        ${isEdit ? renderNoteReadHtml(note.content, { live: true, categories: note.categories || [] }) : ''}
      </div>

      <div class="note-edit-view" id="note-pane-edit" data-pane="edit" role="tabpanel"
           aria-labelledby="note-tab-edit"${initialView === 'edit' ? '' : ' hidden'}>
    <div class="form-group">
      <label class="form-label" for="note-title">${t('notes.titleLabel')}</label>
      <input type="text" class="form-input" id="note-title"
             placeholder="${t('notes.titlePlaceholder')}" value="${esc(isEdit && note.title ? note.title : '')}">
    </div>
    <div class="form-group">
      <label class="form-label" for="note-content">${t('notes.contentLabel')} <span class="form-label__hint">${t('notes.contentMarkdownHint')}</span></label>
      ${renderMarkdownToolbar()}
      <textarea class="form-input" id="note-content" rows="6"
                placeholder="${t('notes.contentPlaceholder')}"
                style="resize:vertical;">${esc(isEdit ? note.content : '')}</textarea>
    </div>
    ${renderCategoryEditor(isEdit ? (note.categories || []).map((category) => category.id) : [])}
    ${advancedSection(`
      <div class="form-group">
        <label class="form-label" id="note-color-label">${t('notes.colorLabel')}</label>
        <div class="note-color-picker" role="radiogroup" aria-labelledby="note-color-label">
          ${swatchColors.map((c) => `
            <div class="note-color-swatch ${c === selColor ? 'note-color-swatch--active' : ''}"
                 data-color="${esc(c)}"
                 style="background-color:${esc(c)};border:2px solid ${c === NOTE_COLORS[7] ? 'var(--color-border)' : esc(c)};"
                 role="radio"
                 tabindex="${c === selColor ? '0' : '-1'}"
                 aria-checked="${c === selColor ? 'true' : 'false'}"
                 aria-label="${esc(NOTE_COLOR_NAMES()[c] ?? t('notes.colorCurrent'))}"></div>
          `).join('')}
        </div>
      </div>
      <div class="form-group">
        <label class="toggle">
          <input type="checkbox" id="note-pinned" ${isEdit && note.pinned ? 'checked' : ''}>
          <span class="toggle__track"></span>
          <span>${t('notes.pinnedLabel')}</span>
        </label>
      </div>`,
      { open: isEdit && (!!note.pinned || (!!note.color && note.color !== NOTE_COLORS[0])) })}
      </div>

      <div class="modal-panel__footer modal-panel__footer--plain note-modal__footer">
        ${isEdit ? `<button type="button" class="btn btn--danger-outline" id="note-modal-delete" style="margin-right:auto">${t('common.delete')}</button>` : ''}
        <button type="button" class="btn btn--secondary" id="note-modal-cancel" data-editor-only>${t('common.cancel')}</button>
        <button type="button" class="btn btn--primary" id="note-modal-save" data-editor-only>${isEdit ? t('common.save') : t('common.create')}</button>
      </div>
    </div>`;

  openSharedModal({
    title: isEdit && note.title && note.title.trim() ? note.title : (isEdit ? t('notes.viewNote') : t('notes.newNote')),
    content,
    // 'lg' statt 'md' (#826): eine Notiz ist fast nur Textflaeche und bekam
    // dieselbe Breite wie ein Formular aus vier kurzen Feldern. Das ist der
    // Dialog, der einheitlich ist, wo er es nicht sein sollte. 'lg' (680px) ist
    // dabei die Groesse, die das Haus fuer inhaltsreiche Dialoge schon fuehrt
    // (Dokumente, Kontakte, Einkauf, Budget) - keine neue Zahl. 'xl' waere zu
    // weit: bei 960px wird die Zeile zum Lesen wie zum Schreiben zu lang, und
    // die Leseansicht derselben Notiz haengt an derselben Breite.
    size: 'lg',
    onClose() {
      editorClosed = true;
    },
    onSave(panel) {
      wireCategoryScopeHelp(panel);
      // Reader/Editor-Umschalter (#507): beide Panes bleiben im DOM, damit
      // Dirty-Check und Feld-Verdrahtung intakt bleiben und der Toggle nichts
      // verwirft. Die Leseansicht wird bei jedem Wechsel aus den Live-Feldern
      // neu gerendert, spiegelt also ungespeicherte Änderungen.
      const noteModal   = panel.querySelector('.note-modal');
      const readPane    = panel.querySelector('[data-pane="read"]');
      const editPane    = panel.querySelector('[data-pane="edit"]');
      const editorOnly  = [...panel.querySelectorAll('[data-editor-only]')];
      const titleEl     = document.getElementById('shared-modal-title');
      const modeTabs    = [...panel.querySelectorAll('.note-mode-switch .sub-tab')];
      const viewTitle   = panel.querySelector('#note-title');
      const viewContent = panel.querySelector('#note-content');
      const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

      function animatePane(pane) {
        if (reduceMotion) return;
        pane.classList.remove('note-pane--enter');
        void pane.offsetWidth; // Reflow: Animation bei jedem Wechsel neu starten
        pane.classList.add('note-pane--enter');
      }

      // Header spiegelt den Titel live (deckt auch Create ab, wo der Header sonst
      // bis zur ersten Vorschau „Neue Notiz" bliebe). Fallback je nach Modus.
      function syncHeaderTitle() {
        if (!titleEl) return;
        titleEl.textContent = viewTitle.value.trim() || (isEdit ? t('notes.viewNote') : t('notes.newNote'));
      }

      function setView(view, { focusField = false } = {}) {
        noteModal.dataset.view = view;
        readPane.hidden = view !== 'read';
        editPane.hidden = view !== 'edit';
        // Abbrechen/Speichern sind nur im Editor sinnvoll. Löschen bleibt in
        // beiden Modi stehen: zuvor verschwand die Fußzeile im Lese-Modus
        // komplett, wodurch die geöffnete Notiz keine einzige Objektaktion mehr
        // anbot — anders als das Aufgaben-Modal, das Löschen inline führt.
        editorOnly.forEach((el) => { el.style.display = view === 'read' ? 'none' : ''; });
        modeTabs.forEach((b) => {
          const on = b.dataset.view === view;
          b.classList.toggle('sub-tab--active', on);
          b.setAttribute('aria-selected', on ? 'true' : 'false');
          b.tabIndex = on ? 0 : -1;
        });
        if (view === 'read') {
          // Live-Spiegelung: Farbe aus dem aktiven Swatch, Inhalt frisch gerendert
          // — Lesemodus zeigt ungespeicherte Änderungen.
          const c = panel.querySelector('.note-color-swatch--active')?.dataset.color;
          if (c) noteModal.style.setProperty('--note-color', c);
          syncHeaderTitle();
          readPane.replaceChildren();
          // Bedienbar nur, solange der Lesemodus den gespeicherten Stand zeigt:
          // sobald im Editor etwas Ungespeichertes steht, zaehlen dessen Zeilen
          // anders als die der Notiz auf dem Server (#704).
          readPane.insertAdjacentHTML('beforeend', renderNoteReadHtml(viewContent.value, {
            live: isEdit && viewContent.value === note.content,
            categories: [...panel.querySelectorAll('input[name="note-category"]:checked')]
              .map((input) => state.categories.find((category) => Number(category.id) === Number(input.value)))
              .filter(Boolean),
          }));
          window.lucide?.createIcons({ el: readPane });
          animatePane(readPane);
        } else {
          animatePane(editPane);
          // Cursor nur bei bewusster Maus-Aktivierung ins Textfeld setzen; bei
          // Pfeiltasten-Navigation bleibt der Fokus auf der Tab-Pille (roving),
          // sonst würde der Textarea-Fokus das Tablist-Verhalten brechen.
          if (focusField) setTimeout(() => viewContent.focus(), 30);
        }
      }
      // Haken im Lesemodus (#704). Der Handler haengt am Pane und nicht an den
      // Kaestchen: die werden bei jedem Moduswechsel neu gezeichnet, der Pane
      // bleibt. Nach dem Umschalten traegt der Textarea den neuen Stand mit,
      // sonst zeigte ein Wechsel in den Editor den Haken nicht mehr.
      readPane.addEventListener('click', async (e) => {
        const box = e.target.closest('.note-md-box[data-md-line]');
        if (!box || !isEdit) return;
        await toggleCheck(note.id, box);
        const fresh = state.notes.find((n) => n.id === note.id);
        if (fresh) {
          note.content = fresh.content;
          if (viewContent.value !== fresh.content) viewContent.value = fresh.content;
        }
      });

      // Initialen Footer-Zustand an die Startansicht angleichen.
      editorOnly.forEach((el) => { el.style.display = initialView === 'read' ? 'none' : ''; });
      viewTitle.addEventListener('input', syncHeaderTitle);

      panel.querySelector('#note-modal-delete')?.addEventListener('click', () => {
        deleteNote(note.id);
      });

      // Umschalt-Buttons + WAI-ARIA-Tablist-Tastatur (Pfeile/Home/End), konsistent
      // mit der geteilten .sub-tab-Grammatik (Budget-Scope, Kitchen-Tabs).
      modeTabs.forEach((tab, i) => {
        // Maus-Klick auf „Bearbeiten“ setzt den Cursor ins Textfeld (Produktivität);
        // „Lesen“ nicht. Pfeiltasten (unten) halten den Fokus auf der Pille.
        tab.addEventListener('click', () => setView(tab.dataset.view, { focusField: tab.dataset.view === 'edit' }));
        tab.addEventListener('keydown', (e) => {
          let ni = null;
          if (e.key === 'ArrowRight' || e.key === 'ArrowDown') ni = (i + 1) % modeTabs.length;
          else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') ni = (i - 1 + modeTabs.length) % modeTabs.length;
          else if (e.key === 'Home') ni = 0;
          else if (e.key === 'End') ni = modeTabs.length - 1;
          if (ni === null) return;
          e.preventDefault();
          setView(modeTabs[ni].dataset.view);
          modeTabs[ni].focus();
        });
      });

      // Fokus beim Öffnen im Lese-Modus auf die aktive Umschalt-Pille (statt auf
      // den Schließen-Button, wo openModal sonst landet). Ein Bedienelement ist
      // der bessere erste Stopp als der große Lese-Container — kleiner Fokusring,
      // sauberer SR-Einstieg in den Lese/Bearbeiten-Umschalter.
      if (initialView === 'read') {
        setTimeout(() => panel.querySelector('.note-mode-switch .sub-tab--active')?.focus(), 80);
      }

      // Farb-Swatch: Auswahl + ARIA + Keyboard (Roving Tabindex)
      function selectSwatch(target) {
        panel.querySelectorAll('.note-color-swatch').forEach((s) => {
          s.classList.remove('note-color-swatch--active');
          s.setAttribute('aria-checked', 'false');
          s.setAttribute('tabindex', '-1');
        });
        target.classList.add('note-color-swatch--active');
        target.setAttribute('aria-checked', 'true');
        target.setAttribute('tabindex', '0');
      }
      panel.querySelectorAll('.note-color-swatch').forEach((sw) => {
        sw.addEventListener('click', () => { selectSwatch(sw); sw.focus(); });
        sw.addEventListener('keydown', (e) => {
          const swatches = [...panel.querySelectorAll('.note-color-swatch')];
          const idx = swatches.indexOf(sw);
          if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
            e.preventDefault();
            const next = swatches[(idx + 1) % swatches.length];
            selectSwatch(next); next.focus();
          } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
            e.preventDefault();
            const prev = swatches[(idx - 1 + swatches.length) % swatches.length];
            selectSwatch(prev); prev.focus();
          } else if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            selectSwatch(sw);
          }
        });
      });

      // Formatierungs-Toolbar (geteilt mit den Aufgaben-Notizen, #731)
      const textarea = panel.querySelector('#note-content');
      wireMarkdownToolbar(panel, textarea);

      const categoryChoices = panel.querySelector('#note-category-choices');
      const categorySearch = panel.querySelector('#note-category-search');
      const categoryList = panel.querySelector('#note-category-suggestions');
      const categoryCreateRow = panel.querySelector('#note-category-create-row');
      const categoryCreateButton = panel.querySelector('#note-category-create');
      const categoryScopeSelect = panel.querySelector('#note-category-new-scope');
      const saveButton = panel.querySelector('#note-modal-save');
      let activeCategoryOption = -1;
      let pendingCategoryCreate = null;
      let noteSavePending = false;

      const editorIsCurrent = () => !editorClosed && panel.isConnected;
      const editorOverlay = panel.closest('.modal-overlay');
      const editorOwnsModalSlot = () => (
        editorIsCurrent()
        && !editorOverlay?.inert
        && document.getElementById('shared-modal-overlay') === editorOverlay
      );

      function closeSavedEditorWhenActive() {
        if (!editorIsCurrent()) return;
        if (editorOwnsModalSlot()) {
          closeModal({ force: true });
          return;
        }

        // The dirty guard parks this editor as an inert, still-connected
        // overlay while its confirmation owns the shared slot. A completed
        // save must not answer that question for the user. If they cancel the
        // discard, close the now-saved editor only after it becomes active
        // again; confirming the discard closes it through the normal path.
        if (!editorOverlay?.inert) return;
        const resumeObserver = new MutationObserver(() => {
          if (!editorIsCurrent()) {
            resumeObserver.disconnect();
          } else if (editorOwnsModalSlot()) {
            resumeObserver.disconnect();
            closeModal({ force: true });
          }
        });
        resumeObserver.observe(editorOverlay, { attributes: true, attributeFilter: ['id', 'inert'] });
      }

      const selectedCreationScope = () => categoryScopeSelect?.value || 'personal';

      const selectedCategoryIds = () => [...categoryChoices.querySelectorAll('input[name="note-category"]:checked')]
        .map((item) => Number(item.value));

      function closeCategorySuggestions() {
        activeCategoryOption = closeCategoryPicker({ categoryList, categorySearch });
      }

      function paintActiveCategoryOption(options) {
        options.forEach((option, index) => {
          const active = index === activeCategoryOption;
          option.classList.toggle('is-active', active);
          option.setAttribute('aria-selected', String(active));
        });
        const active = options[activeCategoryOption];
        if (active) {
          categorySearch.setAttribute('aria-activedescendant', active.id);
          active.scrollIntoView({ block: 'nearest' });
        } else {
          categorySearch.removeAttribute('aria-activedescendant');
        }
      }

      function renderCategorySuggestions({ open = true } = {}) {
        const query = categorySearch.value;
        const available = assignableCategories();
        const suggestions = findCategorySuggestions(available, selectedCategoryIds(), query);
        const creation = categoryCreationState(
          available,
          query,
          selectedCreationScope(),
          !!categoryScopeSelect,
        );

        categoryList.replaceChildren();
        categoryList.insertAdjacentHTML('beforeend', suggestions.map((category, index) => `
          <button type="button" class="note-category-picker__option" role="option"
                  id="note-category-option-${category.id}" data-category-option="${category.id}" tabindex="-1"
                  aria-selected="false">
            <i data-lucide="${category.scope === 'personal' ? 'user' : 'home'}" aria-hidden="true"></i>
            <span>${esc(category.name)}</span>
            <span class="note-category-picker__scope">${esc(categoryScopeLabel(category))}</span>
          </button>`).join(''));
        window.lucide?.createIcons({ el: categoryList });
        activeCategoryOption = activeCategoryOption >= suggestions.length ? -1 : activeCategoryOption;
        paintActiveCategoryOption([...categoryList.querySelectorAll('[role="option"]')]);

        const showList = open && suggestions.length > 0;
        categoryList.hidden = !showList;
        categorySearch.setAttribute('aria-expanded', String(showList));
        categoryCreateRow.hidden = !creation.showControls;
        categoryCreateButton.hidden = !creation.canCreate;
        if (creation.canCreate) {
          categoryCreateButton.textContent = t('noteCategories.createAction', { name: query.trim() });
        }
      }

      function selectCategory(category) {
        if (!category || categoryChoices.querySelector(`[data-selected-category-id="${CSS.escape(String(category.id))}"]`)) return;
        categoryChoices.insertAdjacentHTML('beforeend', renderSelectedCategory(category));
        window.lucide?.createIcons({ el: categoryChoices });
        categorySearch.value = '';
        renderCategorySuggestions({ open: false });
        closeCategorySuggestions();
        categorySearch.focus();
      }

      categoryChoices.addEventListener('click', (event) => {
        const remove = event.target.closest('[data-category-remove]');
        if (!remove) return;
        remove.closest('[data-selected-category-id]')?.remove();
        renderCategorySuggestions({ open: document.activeElement === categorySearch });
        categorySearch.focus();
      });

      categorySearch.addEventListener('focus', () => renderCategorySuggestions());
      categorySearch.addEventListener('input', () => {
        activeCategoryOption = -1;
        renderCategorySuggestions();
      });
      categorySearch.addEventListener('keydown', (event) => {
        if (['ArrowDown', 'ArrowUp', 'Enter', 'Escape'].includes(event.key)) {
          // The modal also handles Enter/Escape. A consumed combobox key must
          // select/close only here, never save or close the whole note modal.
          event.stopPropagation();
        }
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          event.preventDefault();
          const direction = event.key === 'ArrowDown' ? 1 : -1;
          const movement = moveCategoryPickerOption({
            categoryList,
            categorySearch,
            renderSuggestions: renderCategorySuggestions,
            activeIndex: activeCategoryOption,
            direction,
          });
          activeCategoryOption = movement.activeIndex;
        } else if (event.key === 'Enter') {
          event.preventDefault();
          const options = [...categoryList.querySelectorAll('[role="option"]')];
          const active = options[activeCategoryOption];
          if (active) active.click();
          else {
            const exact = findExactCategory(
              assignableCategories(),
              categorySearch.value,
              selectedCreationScope(),
            );
            if (exact) selectCategory(exact);
            else if (!categoryCreateButton.hidden) categoryCreateButton.click();
          }
        } else if (event.key === 'Escape') {
          event.preventDefault();
          closeCategorySuggestions();
        }
      });

      categoryList.addEventListener('click', (event) => {
        const option = event.target.closest('[data-category-option]');
        if (!option) return;
        const category = assignableCategories().find((item) => Number(item.id) === Number(option.dataset.categoryOption));
        selectCategory(category);
      });

      categoryList.addEventListener('pointerdown', (event) => {
        const option = event.target.closest('[data-category-option]');
        if (!option || event.button !== 0) return;
        // The options use aria-activedescendant and intentionally stay out of
        // the tab order. Keep focus on the input until the following click;
        // otherwise focusout hides the list before touch/click can select it.
        event.preventDefault();
      });

      categoryScopeSelect?.addEventListener('change', () => renderCategorySuggestions({
        open: document.activeElement === categorySearch,
      }));

      panel.querySelector('.note-category-picker')?.addEventListener('focusout', () => {
        queueMicrotask(() => {
          if (!panel.querySelector('.note-category-picker')?.contains(document.activeElement)) closeCategorySuggestions();
        });
      });

      categoryCreateButton?.addEventListener('click', async () => {
        if (!editorIsCurrent() || pendingCategoryCreate || noteSavePending) return;
        const name = categorySearch.value.trim();
        if (!name) {
          reportFieldError(categorySearch, t('common.required'));
          return;
        }
        const exact = findExactCategory(assignableCategories(), name, selectedCreationScope());
        if (exact) {
          selectCategory(exact);
          return;
        }
        categoryCreateButton.disabled = true;
        saveButton.disabled = true;
        const scope = selectedCreationScope();
        const createRequest = api.post('/notes/categories', { name, scope });
        pendingCategoryCreate = createRequest;
        try {
          const res = await createRequest;
          const category = res.data;
          if (!state.categories.some((item) => Number(item.id) === Number(category.id))) {
            state.categories.push(category);
          }
          if (!editorIsCurrent()) return;
          selectCategory(category);
          renderFilters();
        } catch (err) {
          if (editorIsCurrent()) {
            window.yuvomi?.showToast(err.data?.error ?? t('common.unknownError'), 'danger');
          }
        } finally {
          if (pendingCategoryCreate === createRequest) pendingCategoryCreate = null;
          if (editorIsCurrent() && !noteSavePending) {
            categoryCreateButton.disabled = false;
            saveButton.disabled = false;
          }
        }
      });

      panel.querySelector('#note-modal-cancel').addEventListener('click', closeModal);

      panel.querySelector('#note-modal-save').addEventListener('click', async () => {
        if (!editorIsCurrent() || noteSavePending || pendingCategoryCreate) return;
        const saveBtn = saveButton;
        const title   = panel.querySelector('#note-title').value.trim() || null;
        const cnt     = panel.querySelector('#note-content').value.trim();
        const color   = panel.querySelector('.note-color-swatch--active')?.dataset.color || NOTE_COLORS[0];
        const pinned  = panel.querySelector('#note-pinned').checked ? 1 : 0;
        const category_ids = [...panel.querySelectorAll('input[name="note-category"]:checked')]
          .map((input) => Number(input.value));

        if (!cnt) {
          // Fehler am Feld statt als ortloser Toast (geteiltes Muster, Critique P1).
          reportFieldError(panel.querySelector('#note-content'), t('common.contentRequired'));
          return;
        }

        noteSavePending = true;
        categoryCreateButton.disabled = true;
        saveBtn.disabled    = true;
        saveBtn.textContent = '…';

        try {
          if (mode === 'create') {
            const res = await api.post('/notes', { title, content: cnt, color, pinned, category_ids });
            state.notes.unshift(res.data);
          } else {
            const res = await api.put(`/notes/${note.id}`, { title, content: cnt, color, pinned, category_ids });
            const idx = state.notes.findIndex((n) => n.id === note.id);
            if (idx !== -1) state.notes[idx] = res.data;
            state.notes.sort((a, b) => b.pinned - a.pinned);
          }
          closeSavedEditorWhenActive();
          renderNotesAndFilters();
          window.yuvomi?.showToast(mode === 'create' ? t('notes.createdToast') : t('notes.savedToast'), 'success');
        } catch (err) {
          window.yuvomi?.showToast(err.data?.error ?? t('common.unknownError'), 'danger');
          if (!editorIsCurrent()) return;
          btnError(saveBtn);
          noteSavePending = false;
          categoryCreateButton.disabled = false;
          saveBtn.disabled    = false;
          saveBtn.textContent = isEdit ? t('common.save') : t('common.create');
        }
      });
    },
  });
}

// --------------------------------------------------------
// Kategorie-Verwaltung
// --------------------------------------------------------

function openNoteCategoryManager() {
  const refresh = async (change = {}) => {
    if (change.action === 'delete') {
      removeNoteCategoryFromState(state, change.key);
      renderNotesAndFilters();
    }
    try {
      const [categoriesRes, notesRes] = await Promise.all([api.get('/notes/categories'), api.get('/notes')]);
      state.categories = categoriesRes.data || [];
      state.canManageHousehold = !!categoriesRes.meta?.can_manage_household;
      state.notes = notesRes.data;
      state.filterCategoryIds = pruneMissingNoteCategoryIds(state.filterCategoryIds, state.categories);
      renderNotesAndFilters();
    } catch (err) {
      // Die Mutation selbst war erfolgreich; dank des optimistischen Updates
      // bleiben gelöschte Badges weg. Der Nutzer muss aber wissen, dass die
      // anschließende Server-Reconciliation nicht gelungen ist.
      console.error('[Notes] Kategorien-Auffrischung fehlgeschlagen:', err);
      window.yuvomi?.showToast(t('notes.loadError'), 'danger');
    }
  };
  const groups = [{ key: 'personal', labelKey: 'noteCategories.personal', addLabelKey: 'common.add' }];
  if (state.canManageHousehold) {
    groups.push({ key: 'household', labelKey: 'noteCategories.household', addLabelKey: 'common.add' });
  }
  openSharedModal({
    title: t('category.manageTitle'),
    content: '<yuvomi-category-manager></yuvomi-category-manager>',
    size: 'lg',
    onSave: (panel) => {
      const manager = panel.querySelector('yuvomi-category-manager');
      // Der Loeschdialog schliesst den Manager VOR dem anschliessenden DELETE,
      // das Element haengt dann nicht mehr im Dokument. Der Listener am Element
      // selbst ueberlebt das - solange sich niemand abmeldet, und genau darauf
      // besteht der Wachhund in test-frontend-audit.js. Aufgeraeumt wird nichts:
      // das Element entsteht je Oeffnen neu und geht mit dem Overlay.
      manager.addEventListener('category-manager-changed', (e) => refresh(e.detail));
      manager.configure({
        basePath: '/notes/categories',
        groups,
        groupField: 'scope',
        labelResolver: (item) => item.name,
        titleKey: 'category.manageTitle',
        hintKey: state.canManageHousehold
          ? 'category.manageHint'
          : 'noteCategories.personalManagementHint',
        deleteDetailKey: 'noteCategories.deleteDetail',
        unifiedAdd: true,
        rowIconResolver: (item) => item.scope === 'personal' ? 'user' : 'home',
        addScopeLabelKey: 'noteCategories.scopeLabel',
        addScopeHelpKey: 'noteCategories.scopeHelp',
      });
    },
  });
}

// --------------------------------------------------------
// Aktionen
// --------------------------------------------------------

async function togglePin(id) {
  try {
    const res  = await api.patch(`/notes/${id}/pin`, {});
    const note = state.notes.find((n) => n.id === id);
    if (note) note.pinned = res.data.pinned;
    state.notes.sort((a, b) => b.pinned - a.pinned);
    renderGrid();
  } catch (err) {
    window.yuvomi?.showToast(err.data?.error ?? t('common.unknownError'), 'danger');
  }
}

/**
 * Notizen frisch vom Server holen (#704).
 *
 * Der Weg nach einem Konflikt: der eigene Stand ist nachweislich veraltet,
 * also wird er ersetzt statt geflickt. Die Sortierung kommt vom Server mit,
 * damit sie nicht ein zweites Mal hier steht.
 */
async function reloadNotes() {
  try {
    const res = await api.get('/notes');
    state.notes = res.data;
    renderNotesAndFilters();
  } catch (err) {
    console.error('[Notes] Neuladen fehlgeschlagen:', err);
  }
}

async function deleteNote(id) {
  closeModal({ force: true });
  const note = state.notes.find((n) => n.id === id);
  state.notes = state.notes.filter((n) => n.id !== id);
  renderNotesAndFilters();
  vibrate([30, 50, 30]);

  scheduleUndoableDelete({
    message: t('notes.deletedToast'),
    commit: ({ keepalive }) => api.delete(`/notes/${id}`, { keepalive }),
    restore: (err) => {
      if (note) {
        state.notes = [...state.notes, note].sort((a, b) => b.pinned - a.pinned);
        renderNotesAndFilters();
      }
      if (err) window.yuvomi?.showToast(err.data?.error ?? t('common.unknownError'), 'danger');
    },
  });
}
