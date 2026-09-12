/**
 * Module: Family Documents
 * Purpose: Grid/list document management with local uploads and member visibility.
 * Dependencies: /api.js, shared modal, i18n
 */

import { api } from '/api.js';
import { openModal as openSharedModal, closeModal, selectModal, advancedSection, promptModal, confirmModal, refocusAfterRender } from '/components/modal.js';
import { t, formatDate, getLocale } from '/i18n.js';
import { esc } from '/utils/html.js';
import { stagger, wireScrollFade, scheduleUndoableDelete } from '/utils/ux.js';
import { renderSkeletonList } from '/utils/skeleton.js';
import { renderPageSearch, wirePageSearch } from '/utils/page-search.js';
import { previewKind } from '/utils/document-preview.js';
import { fileShareSupport } from '/utils/web-share.js';
import { attachOverlay } from '/utils/overlay-history.js';
import { findPageFab } from '/utils/fab.js';
// Im Solo-Haushalt hat „Wer darf das sehen" genau eine Antwort - gefragt wird
// dann nicht (utils/household.js). Das Feld bleibt im DOM und behaelt seinen
// Wert, es ist nur `hidden`: der Absende-Pfad liest es unveraendert, und kommt
// ein zweites Mitglied dazu, steht es wieder da.
import { isSoloHousehold } from '/utils/household.js';
import { maxUploadBytes } from '/utils/upload-limit.js';
import { mountEmptyState } from '/utils/empty-state.js';
import { subtreeIds, folderPath, flattenFolderTree } from '/utils/folder-tree.js';
import {
  buildFolderUploadPlan,
  executeFolderUploadPlan,
  formatFolderUploadTimestamp,
  folderUploadOutcome,
  runRateLimitedOperation,
  supportsDirectoryUpload,
} from '/utils/folder-upload.js';
import {
  applyPendingFolderDeleteOverlay,
  createLatestResponseApplier,
  handleFolderDeleteFailure,
  scheduleFolderDeleteWithUndo,
} from '/utils/document-folder-delete.js';

const CATEGORIES = ['medical', 'school', 'identity', 'insurance', 'finance', 'home', 'vehicle', 'legal', 'travel', 'pets', 'warranty', 'taxes', 'work', 'other'];

const applyLatestDocumentsResponse = createLatestResponseApplier();
const applyLatestFoldersResponse = createLatestResponseApplier();


const CATEGORY_ICONS = {
  medical: 'heart-pulse',
  school: 'graduation-cap',
  identity: 'badge-check',
  insurance: 'shield-check',
  finance: 'landmark',
  home: 'home',
  vehicle: 'car',
  legal: 'scale',
  travel: 'plane',
  pets: 'paw-print',
  warranty: 'receipt',
  taxes: 'file-spreadsheet',
  work: 'briefcase-business',
  other: 'folder',
};

function categoryLabels() {
  return Object.fromEntries(CATEGORIES.map((category) => [category, t(`documents.category.${category}`)]));
}

// Nutzerfreundliche Fehlermeldung: strukturierte Server-Meldung (err.data.error)
// bevorzugt; lokalisierte Client-Validierungsfehler (plain Error mit t()-Text)
// bleiben erhalten; technische ApiError-Strings („HTTP 500"/„offline") werden auf
// eine generische Copy gemappt statt roh angezeigt.
function friendlyError(err) {
  return err?.data?.error
    || (err?.name === 'ApiError' ? t('common.unknownError') : err?.message)
    || t('common.unknownError');
}

// Sortierschlüssel der Liste. `updated` spiegelt die Server-Reihenfolge
// (ORDER BY updated_at DESC) und bleibt daher der Default.
const SORTS = ['updated', 'name', 'size'];

let state = {
  allDocuments: [],
  documents: [],
  folders: [],
  members: [],
  dmsAccounts: [],
  activeUploadBackend: 'local',
  // Mobil ist die kompakte LISTE der Default: die Grid-Karte kostet bei 375px
  // ~260px je Dokument (~1,5 Dokumente je Schirm), die Listenzeile traegt
  // dieselben Angaben auf einem Bruchteil (Critique 2026-08-27, P2). Die
  // gespeicherte Wahl gewinnt auf jedem Geraet; 640px ist die kanonische
  // Mobile-Grenze (tokens.css §11c).
  view: localStorage.getItem('yuvomi-documents-view')
    || (typeof matchMedia !== 'undefined' && matchMedia('(max-width: 639px)').matches ? 'list' : 'grid'),
  sort: SORTS.includes(localStorage.getItem('yuvomi-documents-sort'))
    ? localStorage.getItem('yuvomi-documents-sort')
    : 'updated',
  status: 'active',
  category: '',
  folderId: '',
  query: '',
  selectMode: false,
  selected: new Set(),
  /* Welche Ordner aufgeklappt sind (#785).
   *
   * IM BROWSER GEMERKT UND NICHT AM SERVER: der aufgeklappte Zustand ist eine
   * Eigenschaft dieses Fensters, nicht des Haushalts - zwei Personen sollen
   * nicht gegenseitig ihre Zweige zuklappen. Er ueberlebt den Modulwechsel
   * (localStorage), weil das Zuklappen sonst bei jedem Zurueckkommen von vorn
   * begaenne. */
  expanded: new Set(readExpandedFolders()),
};

/**
 * Die zuletzt aufgeklappten Ordner, gegen kaputten Speicher abgesichert.
 * Ein defekter Eintrag ist kein Grund, das Modul nicht zu zeigen - er ist ein
 * Grund, mit zugeklapptem Baum anzufangen.
 */
function readExpandedFolders() {
  try {
    const raw = JSON.parse(localStorage.getItem('yuvomi-documents-expanded') || '[]');
    return Array.isArray(raw) ? raw.map(Number).filter(Number.isInteger) : [];
  } catch {
    return [];
  }
}

function persistExpandedFolders() {
  try {
    localStorage.setItem('yuvomi-documents-expanded', JSON.stringify([...state.expanded]));
  } catch {
    // Voller oder gesperrter Speicher (privates Fenster): der Baum funktioniert
    // weiter, er erinnert sich nur bis zum naechsten Laden.
  }
}
let _container = null;
let _search = null;

export async function render(container) {
  _container = container;
  const directoryUploadSupported = canPickDirectory();
  container.replaceChildren();
  container.insertAdjacentHTML('beforeend', `
    <div class="documents-page app-page app-page--full" data-composition="full">
      <div class="page-toolbar page-toolbar--wrap documents-toolbar">
        <h1 class="page-toolbar__title">${t('documents.title')}</h1>
        ${renderPageSearch({ id: 'documents-search', label: t('documents.searchPlaceholder'), placeholder: t('documents.searchPlaceholder'), value: state.query, clearLabel: t('common.searchClear'), className: 'documents-toolbar__search page-toolbar__center' })}
        <div class="page-toolbar__actions">
          <button class="btn btn--secondary documents-dms-link-btn" id="documents-dms-link-btn" type="button"
                  title="${t('documents.linkFromDms')}" aria-label="${t('documents.linkFromDms')}" hidden>
            <i data-lucide="link" class="icon-md" aria-hidden="true"></i>
            <span class="documents-dms-link-btn__label">${t('documents.linkFromDms')}</span>
          </button>
          <div class="documents-view-toggle" role="group" aria-label="${t('documents.viewToggle')}">
            <button class="documents-view-toggle__btn ${state.view === 'grid' ? 'documents-view-toggle__btn--active' : ''}" data-view="grid" aria-label="${t('documents.gridView')}" aria-pressed="${state.view === 'grid'}">
              <i data-lucide="layout-grid" aria-hidden="true"></i>
            </button>
            <button class="documents-view-toggle__btn ${state.view === 'list' ? 'documents-view-toggle__btn--active' : ''}" data-view="list" aria-label="${t('documents.listView')}" aria-pressed="${state.view === 'list'}">
              <i data-lucide="list" aria-hidden="true"></i>
            </button>
          </div>
          ${directoryUploadSupported ? `<button class="btn btn--secondary documents-upload-folder-btn" id="documents-upload-folder" type="button"
                  title="${t('documents.folderUpload.openAction')}" aria-label="${t('documents.folderUpload.openAction')}">
            <i data-lucide="folder-up" class="icon-md" aria-hidden="true"></i>
            <span class="documents-upload-folder-btn__label">${t('documents.folderUpload.openAction')}</span>
          </button>` : ''}
        </div>
      </div>
      <div class="documents-selectbar" id="documents-selectbar" role="toolbar" aria-label="${t('documents.selectLabel')}" hidden>
        <button class="btn btn--secondary" type="button" data-action="select-cancel">${t('common.cancel')}</button>
        <span class="documents-selectbar__count" id="documents-select-count" aria-live="polite"></span>
        <div class="documents-selectbar__actions">
          <button class="btn btn--secondary" type="button" data-action="select-all">${t('documents.selectAll')}</button>
          <button class="btn btn--secondary" type="button" data-action="select-move">${t('documents.moveAction')}</button>
          <button class="btn btn--secondary" type="button" data-action="select-archive">${t('documents.archiveAction')}</button>
          <button class="btn btn--danger" type="button" data-action="select-delete">${t('common.delete')}</button>
        </div>
      </div>
      <div class="documents-filters">
        <div class="documents-filter-group" id="documents-status" role="group" aria-label="${t('documents.statusLabel')}">
          <button type="button" class="filter-chip filter-chip--sm${state.status === 'active' ? ' filter-chip--active' : ''}" data-status="active" aria-pressed="${state.status === 'active'}">${t('documents.statusActive')}</button>
          <button type="button" class="filter-chip filter-chip--sm${state.status === 'archived' ? ' filter-chip--active' : ''}" data-status="archived" aria-pressed="${state.status === 'archived'}">${t('documents.statusArchived')}</button>
        </div>
        <div class="documents-filter-chips" id="documents-category" role="group" aria-label="${t('documents.categoryLabel')}"></div>
        <div class="documents-filters__end">
          <label class="sr-only" for="documents-sort">${t('documents.sortLabel')}</label>
          <select class="input documents-sort" id="documents-sort">
            <option value="updated" ${state.sort === 'updated' ? 'selected' : ''}>${t('documents.sortUpdated')}</option>
            <option value="name" ${state.sort === 'name' ? 'selected' : ''}>${t('documents.sortName')}</option>
            <option value="size" ${state.sort === 'size' ? 'selected' : ''}>${t('documents.sortSize')}</option>
          </select>
          <button class="btn btn--secondary btn--icon btn--icon-sm" type="button" id="documents-select-btn"
                  aria-pressed="false" title="${t('documents.selectLabel')}" aria-label="${t('documents.selectLabel')}">
            <i data-lucide="list-checks" class="icon-md" aria-hidden="true"></i>
          </button>
        </div>
      </div>
      <div class="documents-browser-layout">
        <aside class="documents-folder-browser" aria-labelledby="documents-folder-browser-title">
          <div class="documents-folder-browser__head">
            <h2 class="documents-folder-browser__title" id="documents-folder-browser-title">${t('documents.folderBrowserTitle')}</h2>
            ${/* KEIN `aria-label` hier. Es trug "Ordner durchsuchen", waehrend der
                Knopf sichtbar den AKTUELLEN Ordner zeigt: der sichtbare Text stand
                damit nicht im zugaenglichen Namen (WCAG 2.5.3 - Sprachsteuerung
                kann den Knopf nicht ansprechen), und der gewaehlte Ordner, unter
                1024px die einzige Zustandsangabe der Auswahl, wurde nie angesagt.
                Den Bereich benennt bereits das <h2> ueber `aria-labelledby` am
                <aside>; das Label doppelte es und verdeckte den Namen
                (PR-Review #754). Die Beschriftung startet mit dem Standardordner,
                damit der Knopf nie namenlos ist - `renderFolderBrowser` schreibt
                sie danach bei jedem Rendern fort. */ ''}
            <button class="documents-folder-browser__toggle" id="documents-folder-toggle" type="button"
                    aria-expanded="false" aria-controls="documents-folder-browser">
              <i data-lucide="folders" aria-hidden="true"></i>
              <span class="documents-folder-browser__toggle-label">${esc(t('documents.allDocuments'))}</span>
              <i data-lucide="chevron-down" aria-hidden="true" class="documents-folder-browser__chevron"></i>
            </button>
            <button class="documents-folder-browser__add" id="documents-folder-add" type="button" aria-label="${t('documents.addFolderButton')}" title="${t('documents.addFolderButton')}">
              <i data-lucide="folder-plus" aria-hidden="true"></i>
            </button>
          </div>
          <ul class="documents-folder-browser__list row-carrier" id="documents-folder-browser"></ul>
        </aside>
        <div class="documents-browser-main">
          ${/* Der Pfad, in dem man steht (#785). Er steht ueber der Liste und
               nicht in der Seitenleiste: dort ist die Einrueckung schon die
               Auskunft ueber die Lage, hier beantwortet er die Frage, zu
               welchem Ordner die Dokumente daneben gehoeren - unterhalb Tablet
               ist die Leiste ohnehin zugeklappt. Leer, solange kein Ordner
               gewaehlt ist: ein Pfad auf "alle Dokumente" waere eine Zeile
               ohne Aussage. */''}
          <nav class="documents-breadcrumb" id="documents-breadcrumb" aria-label="${t('documents.folderPathLabel')}" hidden></nav>
          <div id="documents-list" class="${listClasses()}" aria-busy="true">${renderSkeletonList({ rows: 6, lines: 2 })}</div>
        </div>
      </div>
      <button class="page-fab" id="fab-new-document" aria-label="${t('documents.addButton')}" data-dock-label="${t('newLabel.documents')}">
        <i data-lucide="upload" class="icon-xl" aria-hidden="true"></i>
      </button>
    </div>
  `);

  if (window.lucide) lucide.createIcons({ el: _container });

  await Promise.all([loadMembers(), loadFolders(), loadMetaOptions()]);
  await loadDocuments();
  renderDmsHeaderBtn();
  bindPageEvents();
  renderCategoryChips();
  renderFolderBrowser();
  renderDocuments();
}

// Alle abhängigen Flächen nach einer Datenänderung neu zeichnen. Die Facetten-
// Zähler (Kategorie + Ordner) hängen voneinander ab, deshalb nie einzeln aufrufen.
function renderAll() {
  renderCategoryChips();
  renderFolderBrowser();
  renderBreadcrumb();
  renderDocuments();
}

/**
 * Der Pfad zum gewaehlten Ordner, jede Stufe anklickbar.
 *
 * DIE LETZTE STUFE IST KEIN LINK. Sie ist der Ort, an dem man schon steht -
 * ein Knopf, der nichts tut, ist eine Zusage, die er nicht einloest. Sie traegt
 * `aria-current="page"`, wie es die Breadcrumb-Praxis vorsieht.
 */
function renderBreadcrumb() {
  const host = _container?.querySelector('#documents-breadcrumb');
  if (!host) return;

  const id = Number(state.folderId);
  const chain = Number.isInteger(id) && id > 0 ? folderPath(state.folders, id) : [];
  host.hidden = chain.length === 0;
  host.replaceChildren();
  if (!chain.length) return;

  host.insertAdjacentHTML('beforeend', `
    <button type="button" class="documents-breadcrumb__crumb" data-folder-select="">
      ${esc(t('documents.allDocuments'))}
    </button>
    ${chain.map((folder, i) => {
    const last = i === chain.length - 1;
    const sep = '<span class="documents-breadcrumb__sep" aria-hidden="true">/</span>';
    return sep + (last
      ? `<span class="documents-breadcrumb__crumb documents-breadcrumb__crumb--current" aria-current="page">${esc(folder.name)}</span>`
      : `<button type="button" class="documents-breadcrumb__crumb" data-folder-select="${folder.id}">${esc(folder.name)}</button>`);
  }).join('')}`);
}

async function loadMembers() {
  const res = await api.get('/family/members');
  state.members = res.data || [];
}

// Nur der Status wird serverseitig gefiltert: Kategorie und Ordner sind
// Facetten über demselben Datensatz und brauchen dessen Gesamtheit, um ehrliche
// Trefferzahlen zeigen zu können. Nebeneffekt: Kategorie-Klicks sind sofort.
async function loadDocuments() {
  return applyLatestDocumentsResponse(
    () => api.get(`/documents?status=${encodeURIComponent(state.status)}`),
    (res) => {
      state.allDocuments = res.data || [];
      applyPendingFolderDeleteOverlay(state, { freshDocuments: true });
      applyFilters();
    },
  );
}

async function loadFolders() {
  return applyLatestFoldersResponse(
    () => api.get('/documents/folders'),
    (res) => {
      state.folders = res.data || [];
      applyPendingFolderDeleteOverlay(state, { freshFolders: true });
    },
  );
}

async function loadMetaOptions() {
  try {
    const res = await api.get('/documents/meta/options');
    state.dmsAccounts = res.data?.dms_accounts || [];
    state.activeUploadBackend = res.data?.active_upload_backend || 'local';
    state.isAdmin = res.data?.is_admin === true;
    // Grenzwerte vom Server übernehmen, statt sie im Client zu duplizieren —
    // sonst driften Hinweistext und tatsächliche Annahme auseinander.
    state.maxFileSize = Number(res.data?.max_file_size) || maxUploadBytes();
    state.allowedMimeTypes = Array.isArray(res.data?.allowed_mime_types) ? res.data.allowed_mime_types : [];
  } catch {
    state.dmsAccounts = [];
    state.activeUploadBackend = 'local';
    state.isAdmin = false;
    state.maxFileSize = maxUploadBytes();
    state.allowedMimeTypes = [];
  }
}

// Der Button liegt fest im Markup (hidden) und wird hier nur freigeschaltet —
// so verschiebt das Nachladen der Konten die Kopfzeile nicht mehr.
function renderDmsHeaderBtn() {
  const btn = _container.querySelector('#documents-dms-link-btn');
  if (!btn) return;
  btn.hidden = !state.dmsAccounts.length;
  if (!btn.hidden && !btn.dataset.wired) {
    btn.dataset.wired = 'true';
    btn.addEventListener('click', () => openDmsLinkModal());
  }
}

function matchesCategory(doc) {
  return !state.category || doc.category === state.category;
}

function matchesFolder(doc) {
  if (state.folderId === '__none') return !doc.folder_id;
  if (!state.folderId) return true;
  /* AUCH DIE UNTERORDNER (#785) - dieselbe Regel wie im Server, sonst zeigen
   * die Zaehler links und die Liste rechts verschiedene Mengen. Der Filter
   * hier ist die Facette (er laeuft ueber `state.allDocuments`, ohne
   * Roundtrip); die Abfrage dort ist die Grenze. Beide muessen dasselbe
   * beantworten. */
  return doc.folder_id != null && folderSubtree(Number(state.folderId)).has(doc.folder_id);
}

function sortDocuments(docs) {
  const sorted = [...docs];
  if (state.sort === 'name') {
    sorted.sort((a, b) => a.name.localeCompare(b.name, getLocale()));
  } else if (state.sort === 'size') {
    sorted.sort((a, b) => (b.file_size || 0) - (a.file_size || 0));
  } else {
    sorted.sort((a, b) => String(b.updated_at || '').localeCompare(String(a.updated_at || '')));
  }
  return sorted;
}

function applyFilters() {
  state.documents = sortDocuments(
    state.allDocuments.filter((doc) => matchesCategory(doc) && matchesFolder(doc)),
  );
}

function bindPageEvents() {
  _container.querySelector('#documents-folder-add')?.addEventListener('click', () => openFolderModal());
  _container.querySelector('#documents-upload-folder')?.addEventListener('click', () => openDocumentModal(null, { initialUpload: 'folder' }));
  findPageFab('fab-new-document')?.addEventListener('click', () => openDocumentModal());

  _search = wirePageSearch(_container, {
    id: 'documents-search',
    onQuery: (value) => {
      state.query = value.trim().toLowerCase();
      renderDocuments();
    },
  });
  _container.querySelector('#documents-status')?.addEventListener('click', (e) => {
    const chip = e.target.closest('[data-status]');
    if (!chip || chip.dataset.status === state.status) return;
    selectStatus(chip.dataset.status);
  });
  // Kategorie ist eine reine Client-Facette: kein Netzwerk-Roundtrip, keine
  // Skeleton-Zwischenstufe — der Filter greift im selben Frame.
  _container.querySelector('#documents-category')?.addEventListener('click', (e) => {
    const chip = e.target.closest('[data-category]');
    if (!chip || chip.dataset.category === state.category) return;
    state.category = chip.dataset.category;
    applyFilters();
    renderAll();
  });
  // Rand-Fade der Kategorie-Chips: geteiltes Utility (Audit F-06) — deckt
  // anders als der frühere Scroll-Listener auch Resize und Re-Render ab.
  //
  // ZWEI KANDIDATEN, WEIL DER SCROLLER MIT DER BREITE WECHSELT: unterhalb des
  // Breakpoints scrollt nicht die Chip-Reihe, sondern die ganze Bedienzeile
  // (documents.css: `.documents-filters { overflow-x: auto }`), und
  // `#documents-category` berechnet dort `overflow-x: visible`. Der Fade hing
  // bis zum Critique 2026-08-28 allein am inneren Element und war damit genau
  // dort weg, wo er gebraucht wird: gemessen 1246px Inhalt auf 390px Viewport
  // ohne jedes Signal, dass es seitlich weitergeht. Auf /contacts liegt
  // dieselbe Konstruktion richtig herum - dort IST die Filterzeile der
  // Scroller, und sie trägt den Helfer.
  //
  // Beide zu verdrahten ist gefahrlos: `update()` vergleicht scrollWidth gegen
  // clientWidth, und ein Element, das nicht überläuft, bekommt keine
  // `has-fade-*`-Klasse. Es gewinnt also immer der, der gerade scrollt.
  wireScrollFade(_container.querySelector('#documents-category'));
  wireScrollFade(_container.querySelector('.documents-filters'));
  _container.querySelector('#documents-sort')?.addEventListener('change', (e) => {
    state.sort = SORTS.includes(e.target.value) ? e.target.value : 'updated';
    localStorage.setItem('yuvomi-documents-sort', state.sort);
    applyFilters();
    renderDocuments();
  });
  _container.querySelector('#documents-select-btn')?.addEventListener('click', () => {
    if (state.selectMode) exitSelectMode();
    else enterSelectMode();
  });
  _container.querySelector('#documents-selectbar')?.addEventListener('click', (e) => {
    const action = e.target.closest('[data-action]')?.dataset.action;
    if (action === 'select-cancel') exitSelectMode();
    else if (action === 'select-all') toggleSelectAll();
    else if (action === 'select-move') moveSelected();
    else if (action === 'select-archive') archiveSelected();
    else if (action === 'select-delete') deleteSelected();
  });
  /* DIESE SEITE BEKOMMT DAS LESEMASS NICHT, und das ist eine Entscheidung.
   *
   * Sie ist als einzige ZWEISPALTIG: der Ordner-Browser steht links, die
   * Dokumentliste beginnt erst bei x=508. Gemessen sind Liste und Bedienzeile
   * beide 720px breit - aber an verschiedenen Startpunkten, und eine
   * Bedienzeile, die an der Content-Kante beginnt, kann mit einer Liste, die
   * 256px weiter rechts beginnt, keine rechte Kante teilen. Die Regel „Kopf
   * fluchtet mit Körper" setzt einspaltig voraus.
   *
   * Hier fluchtet der Kopf stattdessen mit der CONTENT-SPALTE, also mit dem
   * Ordner-Browser plus Liste zusammen - das ist der Körper dieser Seite.
   * (Critique 2026-08-13, zweite Runde.) */
  _container.querySelector('.documents-view-toggle')?.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-view]');
    if (!btn) return;
    state.view = btn.dataset.view;
    localStorage.setItem('yuvomi-documents-view', state.view);
    _container.querySelectorAll('.documents-view-toggle__btn').forEach((el) => {
      const active = el === btn;
      el.classList.toggle('documents-view-toggle__btn--active', active);
      el.setAttribute('aria-pressed', String(active));
    });
    renderDocuments();
  });
  _container.querySelector('#documents-list')?.addEventListener('click', handleDocumentAction);
  /* Der Pfad benutzt dasselbe `data-folder-select` wie die Seitenleiste, aber
   * er haengt an einem anderen Traeger - ein Listener genuegt nicht. Die
   * Auswahl selbst laeuft ueber `selectFolder()`, damit beide Wege dieselben
   * Folgeschritte gehen (Aufklappen, Filtern, Zeichnen). */
  _container.querySelector('#documents-breadcrumb')?.addEventListener('click', (e) => {
    const crumb = e.target.closest('[data-folder-select]');
    if (crumb) selectFolder(crumb.dataset.folderSelect);
  });
  const folderBrowser = _container.querySelector('#documents-folder-browser');
  /* AUFKLAPPEN STATT WISCHEN (≤1023px).
   *
   * Hier stand `wireScrollFade(folderBrowser)`, weil die Liste unterhalb Tablet
   * eine seitlich scrollende Chip-Leiste war. Gemessen bei 390px: clientWidth
   * 356 gegen scrollWidth 1488 - zwei von neun Ordnern sichtbar, bei 320px
   * einer - und das direkt unter der Filterreihe, die schon seitlich scrollt.
   * Zwei verschiedene Dinge mit derselben Geste uebereinander (Critique
   * 2026-08-13, P1).
   *
   * Statt eines Popovers (der Vorschlag der Critique) klappt die Auswahl an
   * Ort und Stelle auf: dieselbe Information, dieselben neun Zeilen, aber ohne
   * den Kontextwechsel eines Overlays fuer eine Handlung, die man beim
   * Durchsehen mehrmals macht. Zugeklappt kostet sie EINE Zeile, die zugleich
   * sagt, in welchem Ordner man steht - weniger Chrome als der Streifen vorher.
   * Am Desktop gibt es keinen Auslöser und die Liste steht immer offen. */
  const folderToggle = _container.querySelector('#documents-folder-toggle');
  const folderAside = _container.querySelector('.documents-folder-browser');
  const setFolderListOpen = (open) => {
    folderAside?.classList.toggle('documents-folder-browser--open', open);
    folderToggle?.setAttribute('aria-expanded', String(open));
  };
  folderToggle?.addEventListener('click', () => {
    setFolderListOpen(folderToggle.getAttribute('aria-expanded') !== 'true');
  });
  folderBrowser?.addEventListener('click', (e) => {
    const menuBtn = e.target.closest('[data-folder-menu]');
    if (menuBtn) {
      const folder = state.folders.find((f) => String(f.id) === menuBtn.dataset.folderMenu);
      if (folder) openFolderMenu(folder, menuBtn);
      return;
    }
    /* Aufklappen wechselt die Ansicht rechts NICHT (#785). Es beantwortet nur
     * "was liegt darunter" - und nur die Seitenleiste wird neu gezeichnet,
     * nicht die Dokumentliste, die sich nicht geaendert hat. */
    const toggleBtn = e.target.closest('[data-folder-toggle]');
    if (toggleBtn) {
      const id = Number(toggleBtn.dataset.folderToggle);
      if (state.expanded.has(id)) state.expanded.delete(id);
      else state.expanded.add(id);
      persistExpandedFolders();
      renderFolderBrowser();
      return;
    }
    const btn = e.target.closest('[data-folder-select]');
    if (!btn) return;
    selectFolder(btn.dataset.folderSelect);
    // Die Wahl beantwortet die Frage, die das Aufklappen gestellt hat: zu.
    // Am Desktop ist der Auslöser ausgeblendet und die Klasse wirkungslos.
    setFolderListOpen(false);
  });
}

/**
 * Einen Ordner waehlen - der eine Weg fuer Seitenleiste und Pfad.
 *
 * @param {string} id  Ordner-id als Zeichenkette, `''` = alle, `'__none'` = ohne Ordner
 */
function selectFolder(id) {
  state.folderId = id;
  /* Wer einen Ordner mit Kindern waehlt, klappt ihn auf: die Ansicht zeigt ab
   * jetzt auch dessen Unterordner, und ein zugeklappter Zweig verschwiege,
   * woher die Dokumente kommen. */
  const chosen = Number(id);
  if (Number.isInteger(chosen) && chosen > 0 && state.folders.some((f) => f.parent_id === chosen)) {
    state.expanded.add(chosen);
    persistExpandedFolders();
  }
  applyFilters();
  renderAll();
}

async function selectStatus(status) {
  if (state.status === status) return;
  state.status = status;
  exitSelectMode();
  _container.querySelectorAll('#documents-status [data-status]').forEach((chip) => {
    const on = chip.dataset.status === status;
    chip.classList.toggle('filter-chip--active', on);
    chip.setAttribute('aria-pressed', String(on));
  });
  showDocumentsLoading();
  await loadDocuments();
  renderAll();
}

// Über den page-search-Handle leeren, damit auch der Lösch-Knopf im Feld
// mitgeht; danach Fokus zurück ins Suchfeld (der auslösende Button verschwindet).
// `clear()` setzt nur das Feld zurück und ruft KEIN onQuery — das Neuzeichnen
// muss hier explizit passieren, sonst bliebe die leere Liste stehen.
function clearSearch() {
  state.query = '';
  _search?.clear();
  renderDocuments();
  _search?.input.focus();
}

function resetFilters() {
  state.category = '';
  state.folderId = '';
  applyFilters();
  renderAll();
}

function filteredDocuments() {
  if (!state.query) return state.documents;
  return state.documents.filter((doc) =>
    doc.name.toLowerCase().includes(state.query) ||
    (doc.description || '').toLowerCase().includes(state.query) ||
    doc.original_name.toLowerCase().includes(state.query)
  );
}

/**
 * Die Klassen des Listen-Trägers. EINE Stelle statt drei: dieselbe Klassenliste
 * stand an drei Orten, und zwei Aufzählungen derselben Arbeit verlieren eine
 * davon einen Schritt (die Auswahl-Klasse fehlte im Ladezustand bereits).
 *
 * Die LISTENANSICHT ist eine Zeilenliste und trägt deren Trägergrammatik
 * (`.row-carrier`, list-row.css): eine randlose Karte, Zeilen darin flächenlos,
 * getrennt über den `+`-Kombinator. Die RASTERANSICHT bleibt ein Raster aus
 * Objekten mit eigenem Medium - die benannte Ausnahme der Zeilenlisten-Regel.
 */
function listClasses() {
  return [
    'documents-list',
    `documents-list--${state.view}`,
    state.view === 'list' ? 'row-carrier' : '',
    state.selectMode ? 'documents-list--selecting' : '',
  ].filter(Boolean).join(' ');
}

// Ladezustand beim Netzwerk-gebundenen Filterwechsel (Status/Kategorie):
// dieselbe Skeleton-Sprache wie beim Erstaufbau, statt die veraltete Liste
// stumm stehen zu lassen. `aria-busy` schaltet die Grid/Flex-Ansicht via CSS
// auf full-width-Block. renderDocuments() räumt beides wieder ab.
function showDocumentsLoading() {
  const list = _container?.querySelector('#documents-list');
  if (!list) return;
  list.className = listClasses();
  list.setAttribute('aria-busy', 'true');
  list.replaceChildren();
  list.insertAdjacentHTML('beforeend', renderSkeletonList({ rows: 6, lines: 2 }));
}

function hasActiveFilter() {
  return Boolean(state.category) || Boolean(state.folderId);
}

// Vier unterscheidbare Leerzustände statt einem. Der alte Einheitszustand
// behauptete „Noch keine Dokumente", während der Ordner-Browser daneben 6 zählte,
// und bot mit „Hochladen" die falsche Reparatur an. Jeder Zustand nennt jetzt die
// tatsächliche Ursache und die Aktion, die sie auflöst.
function emptyStateFor() {
  if (state.query) {
    return {
      variant: 'no-results',
      icon: 'search-x',
      title: t('documents.emptySearchTitle'),
      description: t('documents.emptySearchDescription', { query: state.query }),
      actions: [
        { id: 'documents-empty-clear-search', label: t('common.searchClear'), icon: 'x', variant: 'primary' },
        ...(hasActiveFilter()
          ? [{ id: 'documents-empty-reset', label: t('documents.resetFiltersAction'), icon: 'filter-x', variant: 'secondary' }]
          : []),
      ],
    };
  }
  if (hasActiveFilter()) {
    return {
      variant: 'no-results',
      icon: 'filter-x',
      title: t('documents.emptyFilterTitle'),
      description: t('documents.emptyFilterDescription'),
      actions: [
        { id: 'documents-empty-reset', label: t('documents.resetFiltersAction'), icon: 'filter-x', variant: 'primary' },
        { id: 'documents-empty-upload', label: t('documents.emptyPrimary'), icon: 'upload', variant: 'secondary' },
      ],
    };
  }
  if (state.status === 'archived') {
    return {
      variant: 'empty',
      icon: 'archive',
      title: t('documents.emptyArchivedTitle'),
      description: t('documents.emptyArchivedDescription'),
      actions: [
        { id: 'documents-empty-active', label: t('documents.showActiveAction'), icon: 'corner-up-left', variant: 'primary' },
      ],
    };
  }
  return {
    variant: 'empty',
    icon: 'folder-open',
    title: t('documents.emptyTitle'),
    description: t('documents.emptyDescription'),
    actions: [
      { id: 'documents-empty-upload', label: t('documents.emptyPrimary'), icon: 'upload', variant: 'primary' },
      { id: 'documents-empty-folder', label: t('documents.emptySecondary'), icon: 'folder-plus', variant: 'secondary' },
    ],
  };
}

function renderEmptyState(list) {
  const empty = emptyStateFor();
  // Suche und Filter sind Reaktionen auf eine Eingabe und werden als
  // `no-results` angesagt; „noch nichts hochgeladen" ist gewoehnlicher
  // Seiteninhalt. Der Unterschied stand bisher nur im Text.
  mountEmptyState(list, {
    variant: empty.variant,
    className: 'documents-empty-state',
    icon: empty.icon,
    title: empty.title,
    description: empty.description,
    actions: empty.actions.map((action) => ({
      label: action.label,
      icon: action.icon,
      tone: action.variant,
      attrs: { id: action.id },
    })),
  });
  list.querySelector('#documents-empty-upload')?.addEventListener('click', () => openDocumentModal());
  list.querySelector('#documents-empty-folder')?.addEventListener('click', () => openFolderModal());
  list.querySelector('#documents-empty-clear-search')?.addEventListener('click', () => clearSearch());
  list.querySelector('#documents-empty-reset')?.addEventListener('click', () => resetFilters());
  list.querySelector('#documents-empty-active')?.addEventListener('click', () => selectStatus('active'));
}

function renderDocuments() {
  // Jeder Rerender (Moduswechsel, Filter, Löschen) ersetzt die Karten samt
  // Menü-Anker. Ein offenes Kontextmenü hinge sonst als Geister-Popover im
  // Top-Layer, weil weder Scroll- noch Resize-Listener feuern.
  closeContextMenu();
  const list = _container.querySelector('#documents-list');
  if (!list) return;
  list.removeAttribute('aria-busy');
  const docs = filteredDocuments();
  list.className = listClasses();
  if (!docs.length) {
    renderEmptyState(list);
    return;
  }
  list.replaceChildren();
  list.insertAdjacentHTML('beforeend', docs.map((doc) => state.view === 'list' ? renderListItem(doc) : renderGridCard(doc)).join(''));
  if (window.lucide) lucide.createIcons({ el: list });
  wireThumbnails(list);
  stagger(list.querySelectorAll('.document-card, .document-row'));
}

// Facetten-Zähler: jede Achse zählt unter Berücksichtigung der jeweils ANDEREN
// Achse, aber nicht ihrer selbst. Dadurch führt kein sichtbarer Zähler ins Leere
// und die eigene Auswahl schrumpft die eigene Liste nicht auf einen Eintrag.
/** Der sichtbare Teil des Baums - zugeklappte Zweige bleiben aussen vor. */
function visibleFolderRows() {
  return flattenFolderTree(state.folders, { expanded: state.expanded });
}

/**
 * Der ganze Baum als flache Liste, unabhaengig vom Aufgeklappt-Zustand.
 * Fuer Auswahllisten: dort ist die Einrueckung die Auskunft ueber die Lage,
 * und ein zugeklappter Zweig darf keine Wahl verstecken.
 */
function visibleAllFolderRows() {
  return flattenFolderTree(state.folders);
}

/** Dieser Ordner und alles darunter - dieselbe Regel wie im Server. */
function folderSubtree(folderId) {
  return subtreeIds(state.folders, folderId);
}

function folderCounts() {
  const scope = state.allDocuments.filter(matchesCategory);
  const counts = new Map();
  counts.set('', scope.length);
  counts.set('__none', scope.filter((doc) => !doc.folder_id).length);

  // Erst die eigenen Dokumente je Ordner ...
  const own = new Map();
  scope.forEach((doc) => {
    if (!doc.folder_id) return;
    own.set(doc.folder_id, (own.get(doc.folder_id) || 0) + 1);
  });

  /* ... dann die Summe ueber den Teilbaum. DIE ZAHL MUSS DASSELBE MEINEN WIE
   * DIE ANSICHT DAHINTER: ein Klick auf "Wohnung" zeigt seit dem Baum auch die
   * Dokumente aus "Wohnung/Miete", also darf die Zahl daneben nicht nur die
   * direkt darin liegenden zaehlen. Eine 0 neben einem Ordner, der beim Oeffnen
   * zwoelf Dokumente zeigt, ist schlimmer als gar keine Zahl. */
  state.folders.forEach((folder) => {
    let total = 0;
    for (const id of folderSubtree(folder.id)) total += own.get(id) || 0;
    counts.set(String(folder.id), total);
  });
  return counts;
}

function categoryCounts() {
  const scope = state.allDocuments.filter(matchesFolder);
  const counts = new Map();
  counts.set('', scope.length);
  scope.forEach((doc) => counts.set(doc.category, (counts.get(doc.category) || 0) + 1));
  return counts;
}

// Nur belegte Kategorien werden zu Chips — 15 permanent sichtbare Filter, von
// denen die meisten ins Leere führen, sind Rauschen. Die gerade aktive Kategorie
// bleibt auch bei 0 stehen, damit sie einem beim Ansehen nicht wegspringt.
function renderCategoryChips() {
  const host = _container?.querySelector('#documents-category');
  if (!host) return;
  const counts = categoryCounts();
  const visible = CATEGORIES.filter((category) => counts.get(category) || category === state.category);
  const labels = categoryLabels();
  host.replaceChildren();
  host.insertAdjacentHTML('beforeend', `
    <button type="button" class="filter-chip filter-chip--sm${!state.category ? ' filter-chip--active' : ''}" data-category="" aria-pressed="${!state.category}">
      ${t('documents.allCategories')}<span class="filter-chip__count">${counts.get('') || 0}</span>
    </button>
    ${visible.map((category) => `
    <button type="button" class="filter-chip filter-chip--sm${state.category === category ? ' filter-chip--active' : ''}" data-category="${esc(category)}" aria-pressed="${state.category === category}">
      <i data-lucide="${CATEGORY_ICONS[category] || 'folder'}" class="icon-md" aria-hidden="true"></i>${esc(labels[category])}<span class="filter-chip__count">${counts.get(category) || 0}</span>
    </button>`).join('')}
  `);
  if (window.lucide) lucide.createIcons({ el: host });
}

function renderFolderBrowser() {
  const browser = _container.querySelector('#documents-folder-browser');
  if (!browser) return;
  const counts = folderCounts();
  /* Zwei feste Zeilen, dann der Baum (#785).
   *
   * `depth` ruecken die Zeilen ein, `branch` sagt, ob ein Pfeil davorsteht.
   * Die beiden festen Zeilen sind KEINE Ordner und tragen deshalb weder das
   * eine noch das andere - "alle Dokumente" ist kein Vorfahre von irgendwas.
   */
  const items = [
    { id: '', name: t('documents.allDocuments'), icon: 'folders', managed: false, depth: 0 },
    { id: '__none', name: t('documents.noFolder'), icon: 'folder-x', managed: false, depth: 0 },
    ...visibleFolderRows().map((row) => ({
      id: String(row.folder.id),
      name: row.folder.name,
      // Ein Ordner mit Inhalt sieht anders aus als einer ohne - dieselbe
      // Auskunft, die ein Dateibrowser ueber sein Ordnersymbol gibt.
      icon: row.children.length && state.expanded.has(row.folder.id) ? 'folder-open' : 'folder',
      managed: true,
      depth: row.depth,
      branch: row.children.length > 0,
      open: state.expanded.has(row.folder.id),
    })),
  ];
  browser.replaceChildren();
  /* Die geteilte Zeilen-Grammatik statt einer nachgebauten: `.documents-folder-item`
   * mass 44px min-height, 8px gap, 10px Radius und kappte den Namen mit Ellipse,
   * waehrend `.list-row` 48 / 12 / 0 und `overflow-wrap: anywhere` fuehrt -
   * `/documents` war die einzige Route der App mit NULL `.list-row`-Elementen
   * (Critique 2026-08-13). Der Traeger ist jetzt `.row-carrier`, der die Flaeche
   * und die Trennlinien per `+`-Kombinator stellt, statt sie hier nachzubauen. */
  browser.insertAdjacentHTML('beforeend', items.map((item) => {
    const active = String(state.folderId) === item.id;
    /* DER PFEIL IST EIN EIGENER KNOPF, KEIN KLICK AUF DIE ZEILE. Aufklappen
     * und Hineingehen sind zwei verschiedene Absichten: wer den Inhalt von
     * "Wohnung" sehen will, klickt den Namen; wer nur wissen will, was
     * darunter liegt, klappt auf, ohne die Ansicht rechts zu wechseln. In
     * einen Knopf gelegt kann man das eine nicht ohne das andere.
     *
     * Ordner ohne Kinder bekommen einen leeren Platzhalter statt gar nichts -
     * sonst springen die Namen einer Geschwisterreihe um die Pfeilbreite
     * gegeneinander, je nachdem wer Kinder hat. */
    const twisty = !item.managed ? '' : (item.branch
      ? `<button class="documents-folder-item__twisty" type="button" data-folder-toggle="${esc(item.id)}"
                 aria-expanded="${item.open ? 'true' : 'false'}"
                 aria-label="${esc(item.open ? t('documents.folderCollapse', { name: item.name }) : t('documents.folderExpand', { name: item.name }))}">
           <i data-lucide="chevron-right" aria-hidden="true"></i>
         </button>`
      : '<span class="documents-folder-item__twisty documents-folder-item__twisty--leaf" aria-hidden="true"></span>');

    return `
    <li class="list-row documents-folder-item ${active ? 'documents-folder-item--active' : ''} ${item.managed ? 'documents-folder-item--managed' : ''}"
        style="--folder-depth:${item.depth}">
      ${twisty}
      <button class="documents-folder-item__select list-row__main--interactive" type="button" data-folder-select="${esc(item.id)}" aria-current="${active ? 'true' : 'false'}">
        <span class="documents-folder-item__icon"><i data-lucide="${esc(item.icon)}" aria-hidden="true"></i></span>
        <span class="list-row__name documents-folder-item__name">${esc(item.name)}</span>
        <span class="documents-folder-item__count">${counts.get(item.id) || 0}</span>
      </button>
      ${item.managed ? `
      <button class="documents-folder-item__menu" type="button" data-folder-menu="${esc(item.id)}" aria-label="${t('documents.folderActions')}" title="${t('documents.folderActions')}"
              aria-haspopup="menu" aria-expanded="false">
        <i data-lucide="more-vertical" aria-hidden="true"></i>
      </button>` : ''}
    </li>`;
  }).join(''));
  if (window.lucide) lucide.createIcons({ el: browser });

  // Der Auslöser trägt den Ordner, in dem man steht - unterhalb Tablet ist er
  // die einzige sichtbare Zeile der Auswahl.
  const toggleLabel = _container?.querySelector('.documents-folder-browser__toggle-label');
  if (toggleLabel) {
    toggleLabel.textContent = items.find((i) => String(state.folderId) === i.id)?.name ?? items[0].name;
  }
}

// Rand-Fade horizontal scrollender Leisten: geteilte has-fade-*-Konvention via
// wireScrollFade (utils/ux.js, Audit F-06) — Re-Render triggert dessen
// MutationObserver, daher hier keine manuellen Update-Aufrufe mehr.

// --------------------------------------------------------
// Kontext-Popover (Ordner- & Dokument-Aktionen)
// Native Popover-API wie in den Kontakten: das Panel rendert im Top-Layer
// (kein Clipping durch die Chip-Leiste/Sidebar) und bringt Light-Dismiss,
// Escape und Fokus-Rückgabe mit. Nur Position und Pfeiltasten-Navigation
// bleiben eigener Code.
// --------------------------------------------------------

let _contextMenu = null;

function closeContextMenu() {
  if (!_contextMenu) return;
  const { el } = _contextMenu;
  try { el.hidePopover(); } catch { /* war schon zu */ }
}

// `itemsHtml` liefert die <button role="menuitem" data-menu-action="…">-Einträge,
// `onAction(action)` wird nach dem Schließen mit dem gewählten Wert aufgerufen.
function openContextMenu(anchorBtn, itemsHtml, onAction) {
  closeContextMenu();
  const menu = document.createElement('div');
  menu.className = 'documents-context-menu';
  menu.setAttribute('role', 'menu');
  menu.setAttribute('popover', 'auto');
  menu.insertAdjacentHTML('beforeend', itemsHtml);
  document.body.appendChild(menu);
  if (window.lucide) lucide.createIcons({ el: menu });

  const items = () => Array.from(menu.querySelectorAll('[data-menu-action]'));

  menu.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp' && e.key !== 'Home' && e.key !== 'End') return;
    e.preventDefault();
    const list = items();
    if (!list.length) return;
    const current = list.indexOf(document.activeElement);
    let next;
    if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = list.length - 1;
    else if (e.key === 'ArrowDown') next = current < 0 ? 0 : (current + 1) % list.length;
    else next = current <= 0 ? list.length - 1 : current - 1;
    list[next].focus();
  });

  menu.addEventListener('click', (e) => {
    const item = e.target.closest('[data-menu-action]');
    if (!item) return;
    const action = item.dataset.menuAction;
    closeContextMenu();
    onAction(action);
  });

  // Aufräumen zentral am Schließen — egal ob per Auswahl, Escape, Klick
  // daneben oder Scroll. Der Fokus geht an den Auslöser zurück.
  // Der toggle-Event feuert ASYNCHRON: Öffnet ein zweiter Kebab sein Menü,
  // bevor das Schließ-Event des ersten verarbeitet ist, zeigt _contextMenu
  // bereits auf das neue Menü. Der verspätete Handler des alten darf dann
  // weder die Registrierung nullen noch die geteilten window-Listener oder
  // den Fokus anfassen — sonst wird das neue Menü unschließbar (Geister-
  // Popover, Audit A2-13).
  menu.addEventListener('toggle', (e) => {
    if (e.newState === 'open') return;
    anchorBtn.setAttribute('aria-expanded', 'false');
    if (_contextMenu?.el === menu) {
      window.removeEventListener('resize', closeContextMenu, true);
      window.removeEventListener('scroll', closeContextMenu, true);
      _contextMenu = null;
      if (anchorBtn.isConnected) anchorBtn.focus();
    }
    menu.remove();
  });

  menu.showPopover();
  positionContextMenu(menu, anchorBtn);
  anchorBtn.setAttribute('aria-expanded', 'true');
  _contextMenu = { el: menu, anchorBtn };
  window.addEventListener('resize', closeContextMenu, true);
  window.addEventListener('scroll', closeContextMenu, true);
  items()[0]?.focus();
}

// Rechtsbündig unter dem Auslöser, mit Kipp-Logik nach oben und Rand-Klemmung,
// damit das Panel am Viewport-Rand nicht abgeschnitten wird.
function positionContextMenu(menu, anchorBtn) {
  const r = anchorBtn.getBoundingClientRect();
  const mw = menu.offsetWidth;
  const mh = menu.offsetHeight;
  let left = Math.max(8, r.right - mw);
  left = Math.min(left, window.innerWidth - mw - 8);
  let top = r.bottom + 4;
  if (top + mh > window.innerHeight - 8) top = Math.max(8, r.top - mh - 4);
  menu.style.left = `${Math.round(left)}px`;
  menu.style.top = `${Math.round(top)}px`;
}

function openFolderMenu(folder, anchorBtn) {
  openContextMenu(anchorBtn, `
    <button class="documents-context-menu__item" type="button" role="menuitem" data-menu-action="subfolder">
      <i data-lucide="folder-plus" aria-hidden="true"></i><span>${t('documents.newSubfolder')}</span>
    </button>
    <button class="documents-context-menu__item" type="button" role="menuitem" data-menu-action="rename">
      <i data-lucide="pencil" aria-hidden="true"></i><span>${t('documents.renameFolder')}</span>
    </button>
    <button class="documents-context-menu__item" type="button" role="menuitem" data-menu-action="move">
      <i data-lucide="folder-input" aria-hidden="true"></i><span>${t('documents.moveFolder')}</span>
    </button>
    <button class="documents-context-menu__item documents-context-menu__item--danger" type="button" role="menuitem" data-menu-action="delete">
      <i data-lucide="trash-2" aria-hidden="true"></i><span>${t('documents.deleteFolder')}</span>
    </button>
  `, async (action) => {
    if (action === 'subfolder') openFolderModal({ parentId: folder.id });
    else if (action === 'rename') await renameFolder(folder);
    else if (action === 'move') await moveFolder(folder);
    else if (action === 'delete') await deleteFolder(folder);
  });
}

/**
 * Ein Ordner zieht um.
 *
 * DIE AUSWAHL ZEIGT NICHT ALLE ORDNER, sondern nur die moeglichen: der Ordner
 * selbst und sein ganzer Teilbaum fehlen, weil ein Ordner nicht in sich selbst
 * ziehen kann. Der Server weist das ohnehin ab - eine Auswahl, die eine Absage
 * anbietet, ist trotzdem eine schlechte Auswahl.
 */
async function moveFolder(folder) {
  const forbidden = folderSubtree(folder.id);
  const options = [
    { value: '', label: t('documents.folderRootLevel') },
    ...visibleAllFolderRows()
      .filter((row) => !forbidden.has(row.folder.id))
      .map((row) => ({ value: String(row.folder.id), label: `${'  '.repeat(row.depth)}${row.folder.name}` })),
  ];

  const chosen = await selectModal(t('documents.moveFolderTo', { name: folder.name }), options);
  if (chosen === null) return;
  try {
    await api.put(`/documents/folders/${folder.id}`, { parent_id: chosen === '' ? null : Number(chosen) });
    window.yuvomi?.showToast(t('documents.folderMovedToast'), 'success');
    // Der neue Elternteil wird aufgeklappt, sonst verschwindet der Ordner
    // scheinbar - er sitzt dann in einem zugeklappten Zweig.
    if (chosen !== '') state.expanded.add(Number(chosen));
    persistExpandedFolders();
    await Promise.all([loadFolders(), loadDocuments()]);
    renderAll();
    refocusAfterRender();
  } catch (err) {
    window.yuvomi?.showToast(err.data?.error ?? t('common.unknownError'), 'danger');
  }
}

// Overflow-Menü einer Dokumentkarte/-zeile: Sekundäraktionen aus der Aktionszeile
// (bearbeiten, archivieren, an DMS senden, löschen) — hält die Zeile auf zwei
// Primäraktionen (Ansehen/Download) + Kebab begrenzt.
function openDocumentMenu(doc, anchorBtn) {
  const archived = doc.status === 'archived';
  const canPushDms = documentStorageBackend(doc) !== 'dms' && state.dmsAccounts.length > 0;
  openContextMenu(anchorBtn, `
    <button class="documents-context-menu__item" type="button" role="menuitem" data-menu-action="edit">
      <i data-lucide="pencil" aria-hidden="true"></i><span>${t('common.edit')}</span>
    </button>
    <button class="documents-context-menu__item" type="button" role="menuitem" data-menu-action="move">
      <i data-lucide="folder-input" aria-hidden="true"></i><span>${t('documents.moveAction')}</span>
    </button>
    <button class="documents-context-menu__item" type="button" role="menuitem" data-menu-action="archive">
      <i data-lucide="${archived ? 'archive-restore' : 'archive'}" aria-hidden="true"></i><span>${archived ? t('documents.restoreAction') : t('documents.archiveAction')}</span>
    </button>
    ${canPushDms ? `
    <button class="documents-context-menu__item" type="button" role="menuitem" data-menu-action="push-dms">
      <i data-lucide="upload" aria-hidden="true"></i><span>${t('documents.pushToDms')}</span>
    </button>` : ''}
    <button class="documents-context-menu__item documents-context-menu__item--danger" type="button" role="menuitem" data-menu-action="delete">
      <i data-lucide="trash-2" aria-hidden="true"></i><span>${t('common.delete')}</span>
    </button>
  `, (action) => runDocumentAction(action, doc));
}

async function renameFolder(folder) {
  const newName = await promptModal(t('documents.renameFolder'), folder.name);
  if (!newName || newName === folder.name) return;
  try {
    await api.put(`/documents/folders/${folder.id}`, { name: newName });
    window.yuvomi?.showToast(t('documents.folderRenamedToast'), 'success');
    // Dokumente mitladen: `folder_name` steckt im Server-Join und stünde sonst
    // auf den Karten weiter mit dem alten Namen.
    await Promise.all([loadFolders(), loadDocuments()]);
    renderAll();
    refocusAfterRender();
  } catch (err) {
    window.yuvomi?.showToast(err.data?.error ?? t('common.unknownError'), 'danger');
  }
}

function folderDeleteChoice(folder, impact) {
  const descendants = Math.max(0, Number(impact.removed_folders) - 1);
  const documents = Math.max(0, Number(impact.documents));
  const linkedRecordLabels = [
    ['calendar', t('nav.calendar')],
    ['housekeeping', t('nav.housekeeping')],
    ['split_expenses', t('splitExpenses.title')],
    ['tasks', t('nav.tasks')],
    ['budget', t('nav.budget')],
    ['inventory', t('nav.inventory')],
  ];
  const linkedRecords = linkedRecordLabels
    .map(([key, label]) => ({ label, count: Math.max(0, Number(impact.linked_records?.[key] || 0)) }))
    .filter(({ count }) => count > 0)
    .map(({ label, count }) => `${label}: ${count}`)
    .join(' · ');
  return new Promise((resolve) => {
    let resolved = false;
    const finish = (value) => {
      if (resolved) return;
      resolved = true;
      closeModal({ force: true });
      resolve(value);
    };

    openSharedModal({
      title: t('documents.deleteFolderConfirm', { name: folder.name }),
      size: 'sm',
      content: `
        <p class="modal-confirm__detail">${esc(t('documents.deleteFolderImpact', {
          documents,
          folders: descendants,
        }))}</p>
        ${linkedRecords ? `
          <p class="modal-confirm__detail">
            ${esc(t('documents.deleteFolderLinkedRecords'))}<br>${esc(linkedRecords)}
          </p>` : ''}
        ${impact.can_delete_documents ? '' : `
          <p class="modal-confirm__detail" id="documents-folder-delete-unavailable">
            ${esc(t('documents.deleteFolderDocumentsUnavailable'))}
          </p>`}
        <div class="modal-actions modal-actions--stack">
          <button type="button" class="btn btn--primary" id="documents-folder-delete-unfile">
            ${esc(t('documents.deleteFolderKeepDocuments', { count: documents }))}
          </button>
          <button type="button" class="btn btn--danger" id="documents-folder-delete-documents"
                  ${impact.can_delete_documents ? '' : 'disabled aria-describedby="documents-folder-delete-unavailable"'}>
            ${esc(t('documents.deleteFolderWithDocuments', { count: documents }))}
          </button>
          <button type="button" class="btn btn--ghost" id="documents-folder-delete-cancel">${esc(t('common.cancel'))}</button>
        </div>`,
      onClose: () => finish(null),
      onSave(panel) {
        panel.querySelector('#documents-folder-delete-unfile')?.addEventListener('click', () => finish('unfile'));
        panel.querySelector('#documents-folder-delete-documents')?.addEventListener('click', () => finish('delete'));
        panel.querySelector('#documents-folder-delete-cancel')?.addEventListener('click', () => finish(null));
      },
    });
  });
}

async function deleteFolder(folder) {
  let impact;
  try {
    const response = await api.get(`/documents/folders/${folder.id}/delete-impact`);
    impact = response.data;
  } catch (err) {
    window.yuvomi?.showToast(friendlyError(err), 'danger');
    return;
  }

  let choice;
  if (impact.documents > 0 || !impact.can_delete_documents) {
    choice = await folderDeleteChoice(folder, impact);
  } else {
    const descendants = Math.max(0, Number(impact.removed_folders) - 1);
    const confirmed = await confirmModal(
      t('documents.deleteFolderConfirm', { name: folder.name }),
      {
        danger: true,
        confirmLabel: t('documents.deleteFolder'),
        detail: t('documents.deleteFolderImpact', { folders: descendants, documents: 0 }),
      },
    );
    choice = confirmed ? 'unfile' : null;
  }
  if (!choice) return;

  const selectedSubtree = folderSubtree(folder.id);
  if (choice === 'delete') {
    scheduleFolderDeleteWithUndo({
      state,
      folderIds: selectedSubtree,
      message: t('documents.folderDeletedWithDocumentsToast', { count: impact.documents }),
      schedule: scheduleUndoableDelete,
      requestDelete: ({ keepalive }) => (
        commitFolderDeletion(folder, impact, choice, { keepalive })
      ),
      isViewActive: () => Boolean(_container?.isConnected),
      applyResult: (result, { viewActive }) => (
        applyFolderDeleteResult(result, choice, selectedSubtree, {
          showSuccess: false,
          renderView: viewActive,
        })
      ),
      handleError: (err) => handleFolderDeleteError(err, folder, { delayed: true }),
      // The server deletion has already succeeded at this point. A failed
      // refresh must not restore records that no longer exist server-side.
      handleApplyError: (err) => {
        window.yuvomi?.showToast(friendlyError(err), 'danger');
      },
      render: () => {
        persistExpandedFolders();
        applyFilters();
        renderAll();
      },
    });
    return;
  }

  try {
    const result = await commitFolderDeletion(folder, impact, choice);
    await applyFolderDeleteResult(result, choice, selectedSubtree);
    refocusAfterRender();
  } catch (err) {
    await handleFolderDeleteError(err, folder);
  }
}

async function commitFolderDeletion(folder, impact, choice, { keepalive = false } = {}) {
  const expectedSnapshot = choice === 'delete'
    ? `&expected_snapshot=${encodeURIComponent(impact.snapshot)}`
    : '';
  const response = await api.delete(
    `/documents/folders/${folder.id}?documents=${choice}`
    + `&expected_documents=${impact.documents}&expected_folders=${impact.removed_folders}`
    + expectedSnapshot,
    { keepalive },
  );
  return response.data;
}

async function applyFolderDeleteResult(
  result,
  choice,
  selectedSubtree,
  { showSuccess = true, renderView = true } = {},
) {
  const hasNonConcurrencyFailure = result.failed_documents
    ?.some((failure) => failure.failure_stage !== 'concurrency');
  if (result.folder_deleted === false && result.contents_changed && hasNonConcurrencyFailure) {
    window.yuvomi?.showToast(t('documents.folderDeleteContentsChangedWithFailuresToast'), 'warning');
  } else if (result.folder_deleted === false && result.contents_changed) {
    window.yuvomi?.showToast(t('documents.folderDeleteContentsChangedToast', {
      deleted: result.deleted_documents,
    }), 'warning');
  } else if (result.folder_deleted === false) {
    window.yuvomi?.showToast(t('documents.folderDeletePartialToast', {
      deleted: result.deleted_documents,
      failed: result.failed_documents?.length || 0,
    }), 'warning');
  } else if (showSuccess && choice === 'delete') {
    window.yuvomi?.showToast(t('documents.folderDeletedWithDocumentsToast', { count: result.deleted_documents }), 'default');
  } else if (showSuccess) {
    window.yuvomi?.showToast(t('documents.folderDeletedToast'), 'default');
  }
  if (result.folder_deleted !== false && selectedSubtree.has(Number(state.folderId))) state.folderId = '';
  await Promise.all([loadFolders(), loadDocuments()]);
  if (renderView) renderAll();
}

async function handleFolderDeleteError(err, folder, { delayed = false } = {}) {
  await handleFolderDeleteFailure({
    err,
    delayed,
    translate: t,
    showToast: (...args) => window.yuvomi?.showToast(...args),
    refreshImpact: () => deleteFolder(folder),
  });
}

// `showSize` aus, wenn die Ansicht die Größe bereits in einer eigenen Spalte
// führt (Listenzeile) — sonst stünde sie doppelt in derselben Zeile.
function renderMeta(doc, { showSize = true } = {}) {
  const labels = categoryLabels();
  const categoryLabel = labels[doc.category] || doc.category;
  // Der Ordner-Chip entfaellt, wenn der Ordner woertlich wie die Kategorie
  // heisst: „Schule · Schule" sagte dasselbe zweimal auf jeder Karte
  // (Critique 2026-08-27, P3). Nur exakte Gleichheit - ein Ordner
  // „Versicherungen" unter der Kategorie „Versicherung" ist eine
  // Nutzerentscheidung und bleibt sichtbar.
  const folderDuplicatesCategory = doc.folder_name
    && doc.folder_name.trim().toLowerCase() === String(categoryLabel).trim().toLowerCase();
  return `
    <span><i data-lucide="${CATEGORY_ICONS[doc.category] || 'folder'}" aria-hidden="true"></i>${categoryLabel}</span>
    ${doc.folder_name && !folderDuplicatesCategory ? `<span><i data-lucide="folder" aria-hidden="true"></i>${esc(doc.folder_name)}</span>` : ''}
    ${isSoloHousehold() ? '' : `<span><i data-lucide="${doc.visibility === 'family' ? 'users' : doc.visibility === 'private' ? 'lock' : 'user-check'}" aria-hidden="true"></i>${t(`documents.visibility.${doc.visibility}`)}</span>`}
    ${showSize ? `<span>${formatFileSize(doc.file_size)}</span>` : ''}
    ${storageBadgeHtml(doc)}
  `;
}

function documentStorageBackend(doc) {
  if (doc.storage_backend) return doc.storage_backend;
  return doc.storage_provider === 'external' ? 'dms' : 'local';
}

// Kompaktes Vorschaubild (Issue #533): nur DMS-Dokumente mit vorhandenem Konto,
// deren Provider Thumbnails liefert. Papra hat keinen Thumb-Endpoint -> gar nicht
// erst anfragen, damit keine ins Leere laufenden 415-Requests entstehen.
function docSupportsThumbnail(doc) {
  return documentStorageBackend(doc) === 'dms'
    && Boolean(doc.dms_account_id)
    && doc.dms_provider === 'paperless';
}

// Icon-Slot einer Karte: Kategorie-Glyph, plus (bei Thumbnail-Support) ein Bild,
// das nach erfolgreichem Laden das Glyph ersetzt. Schlägt das Laden fehl, bleibt
// das Glyph stehen (Fallback auf die bisherige Darstellung).
function renderDocIconSlot(doc) {
  const icon = `<i data-lucide="${CATEGORY_ICONS[doc.category] || 'file'}" aria-hidden="true"></i>`;
  if (!docSupportsThumbnail(doc)) return icon;
  return `<span class="document-thumb__glyph" data-thumb-icon>${icon}</span>`
    + `<img class="document-thumb__img" data-thumb="clickable" src="/api/v1/documents/${doc.id}/thumbnail"`
    + ` alt="" loading="lazy" width="42" height="42" hidden>`;
}

function fileTypeLabel(filename) {
  const ext = String(filename || '').toLowerCase().match(/\.([a-z0-9]+)$/)?.[1];
  return ext ? ext.toUpperCase() : '';
}

// Zeigt das geladene Thumbnail und blendet den Glyph-Fallback aus. Deckt auch den
// Cache-Fall ab, in dem das Bild schon vor dem Listener-Bind fertig geladen ist.
function wireThumbnails(root) {
  root.querySelectorAll('img[data-thumb]').forEach((img) => {
    const reveal = () => {
      if (!img.naturalWidth) { img.remove(); return; }
      img.hidden = false;
      img.parentElement?.querySelector('[data-thumb-icon]')?.setAttribute('hidden', '');
      // Erst wenn ein Thumbnail steht, signalisiert der Icon-Slot per Cursor/Hover,
      // dass er (wie die ganze Karte) den Viewer öffnet. data-thumb-clickable grenzt
      // die Karten-Thumbnails vom rein identifizierenden Picker-Thumbnail ab.
      if (img.dataset.thumb === 'clickable') img.parentElement?.classList.add('document-thumb--ready');
    };
    if (img.complete) { reveal(); return; }
    img.addEventListener('load', reveal, { once: true });
    img.addEventListener('error', () => img.remove(), { once: true });
  });
}

function uploadBackendLabel(backend) {
  if (backend === 'webdav') return t('documents.storageWebdav');
  if (backend === 'google_drive') return t('documents.storageGoogleDrive');
  if (backend === 'local_folder') return t('documents.storageLocalFolder');
  return t('documents.storageLocal');
}

function uploadTargetIcon(backend) {
  if (backend === 'google_drive') return 'cloud-upload';
  if (backend === 'webdav') return 'cloud';
  if (backend === 'local_folder') return 'folder';
  return 'database';
}

function storageBadgeHtml(doc) {
  const backend = documentStorageBackend(doc);
  if (backend === 'webdav') {
    return `<span class="doc-badge doc-badge--webdav">${t('documents.storageWebdav')}</span>`;
  }
  if (backend === 'google_drive') {
    return `<span class="doc-badge doc-badge--google-drive">${t('documents.storageGoogleDrive')}</span>`;
  }
  if (backend === 'dms' && !doc.dms_account_id) {
    return `<span class="doc-badge doc-badge--unavailable">${t('documents.storageDmsUnavailable')}</span>`;
  }
  if (backend === 'dms') {
    return `<span class="doc-badge doc-badge--dms">${t('documents.storageDms')}</span>`;
  }
  // Folder-backed local documents carry a storage_key; they are a non-default
  // target and earn a badge. The in-DB BLOB default (no key) stays badge-less so
  // a badge remains a meaningful signal.
  if (backend === 'local' && doc.storage_key) {
    return `<span class="doc-badge doc-badge--folder">${t('documents.storageLocalFolder')}</span>`;
  }
  return '';
}

// Zwei Primäraktionen (Ansehen/Download) bleiben in der Zeile; alles Weitere
// (bearbeiten, archivieren, DMS, löschen) liegt hinter dem Kebab-Overflow.
// „Ansehen" wird für ALLE Typen gerendert — auch nicht darstellbare öffnen die
// Detailansicht (mit Download-Fallback) und sind so per Tastatur erreichbar.
function renderActions(doc) {
  return `
    <button class="btn btn--ghost btn--icon btn--icon-sm" data-action="view" data-id="${doc.id}" title="${t('documents.viewAction')}" aria-label="${t('documents.viewAction')}">
      <i data-lucide="eye" class="icon-md" aria-hidden="true"></i>
    </button>
    <a class="btn btn--ghost btn--icon btn--icon-sm" href="/api/v1/documents/${doc.id}/download" download title="${t('documents.downloadAction')}" aria-label="${t('documents.downloadAction')}">
      <i data-lucide="download" class="icon-md" aria-hidden="true"></i>
    </a>
    <button class="btn btn--ghost btn--icon btn--icon-sm" data-action="menu" data-id="${doc.id}" title="${t('nav.more')}" aria-label="${t('nav.more')}" aria-haspopup="menu" aria-expanded="false">
      <i data-lucide="more-vertical" class="icon-md" aria-hidden="true"></i>
    </button>
  `;
}

// Auswahl-Kachel im Icon-Slot: im Auswahlmodus ersetzt die Checkbox die
// Einzelaktionen, damit Karte und Zeile nicht zwei konkurrierende Klickziele tragen.
function renderSelectBox(doc) {
  if (!state.selectMode) return '';
  const checked = state.selected.has(doc.id);
  return `
    <label class="document-select">
      <input type="checkbox" data-select-id="${doc.id}" ${checked ? 'checked' : ''}
             aria-label="${esc(t('documents.selectDocument', { name: doc.name }))}">
    </label>`;
}

function renderGridCard(doc) {
  const selected = state.selectMode && state.selected.has(doc.id);
  return `
    <article class="document-card${selected ? ' is-selected' : ''}" data-id="${doc.id}">
      <div class="document-card__header">
        ${state.selectMode ? renderSelectBox(doc) : `<div class="document-card__icon document-thumb">${renderDocIconSlot(doc)}</div>`}
        <span class="document-card__date">${formatDate(doc.updated_at)}</span>
      </div>
      <div class="document-card__body">
        <h2 class="document-card__title">${esc(doc.name)}</h2>
        <p class="document-card__description">${esc(doc.description || doc.original_name)}</p>
        <div class="document-card__meta">${renderMeta(doc)}</div>
      </div>
      ${state.selectMode ? '' : `<div class="document-card__actions">${renderActions(doc)}</div>`}
    </article>
  `;
}

// Die Zeile trägt bewusst mehr als die Karte: Datum und Größe stehen als eigene
// Spalten rechts. Vorher zeigte die Listenansicht kein Datum — der Wechsel von
// Raster auf Liste nahm Information weg, statt Dichte zu gewinnen.
function renderListItem(doc) {
  const selected = state.selectMode && state.selected.has(doc.id);
  return `
    <article class="list-row document-row${selected ? ' is-selected' : ''}" data-id="${doc.id}">
      ${state.selectMode ? renderSelectBox(doc) : `<div class="document-row__icon document-thumb">${renderDocIconSlot(doc)}</div>`}
      <div class="list-row__main document-row__body">
        <h2 class="list-row__name document-row__title">${esc(doc.name)}</h2>
        <div class="list-row__meta document-row__meta">${renderMeta(doc, { showSize: false })}</div>
      </div>
      <div class="document-row__stats">
        <span class="document-row__date">${formatDate(doc.updated_at)}</span>
        <span class="document-row__size">${formatFileSize(doc.file_size)}</span>
      </div>
      ${state.selectMode ? '' : `<div class="document-row__actions">${renderActions(doc)}</div>`}
    </article>
  `;
}

function handleDocumentAction(e) {
  // Im Auswahlmodus ist die ganze Karte/Zeile ein Umschalter — die Checkbox ist
  // die sichtbare Anzeige, nicht das einzige Ziel (Fitts' Law auf Touch).
  if (state.selectMode) {
    const card = e.target.closest('[data-id]');
    if (!card) return;
    const id = Number(card.dataset.id);
    const box = card.querySelector('[data-select-id]');
    // Ein direkter Checkbox-Klick hat den Zustand schon umgeschaltet.
    const next = e.target === box ? box.checked : !state.selected.has(id);
    if (next) state.selected.add(id);
    else state.selected.delete(id);
    if (box) box.checked = next;
    card.classList.toggle('is-selected', next);
    updateSelectUI();
    return;
  }
  const menuBtn = e.target.closest('[data-action="menu"]');
  if (menuBtn) {
    const doc = state.documents.find((item) => String(item.id) === String(menuBtn.dataset.id));
    if (doc) openDocumentMenu(doc, menuBtn);
    return;
  }
  // Klick auf Karte/Zeile (nicht auf einen Button/Link) → Viewer öffnen
  if (!e.target.closest('[data-action]') && !e.target.closest('a') && !e.target.closest('.btn')) {
    const card = e.target.closest('[data-id]');
    if (card) {
      const doc = state.documents.find((item) => String(item.id) === String(card.dataset.id));
      if (doc) openDocumentViewer(doc);
    }
    return;
  }
  const btn = e.target.closest('[data-action]');
  if (!btn) return;
  const doc = state.documents.find((item) => String(item.id) === String(btn.dataset.id));
  if (doc) runDocumentAction(btn.dataset.action, doc);
}

async function runDocumentAction(action, doc) {
  if (action === 'view') openDocumentViewer(doc);
  if (action === 'edit') openDocumentModal(doc);
  if (action === 'move') {
    state.selected = new Set([doc.id]);
    await moveSelected();
    state.selected.clear();
    return;
  }
  if (action === 'archive') {
    await api.patch(`/documents/${doc.id}/archive`, { archived: doc.status !== 'archived' });
    window.yuvomi?.showToast(doc.status === 'archived' ? t('documents.restoredToast') : t('documents.archivedToast'), 'success');
    await loadDocuments();
    renderAll();
  }
  if (action === 'push-dms') {
    if (!state.dmsAccounts.length) return;
    let accountId = state.dmsAccounts[0].id;
    if (state.dmsAccounts.length > 1) {
      // Bei mehreren DMS-Konten Ziel auswählen lassen (promise-basiertes Auswahl-Modal
      // ohne Dirty-Check, Abbruch → null).
      accountId = await selectModal(
        t('documents.pushToDms'),
        state.dmsAccounts.map((account) => ({ value: account.id, label: account.name })),
      );
      if (!accountId) return;
    }
    try {
      await api.post('/documents/dms/push', { account_id: accountId, document_id: doc.id });
      window.yuvomi?.showToast(t('documents.pushToDmsQueued'), 'success');
    } catch (err) {
      window.yuvomi?.showToast(err.data?.error ?? t('common.unknownError'), 'danger');
    }
    return;
  }
  if (action === 'delete') deleteDocuments([doc]);
}

// Optimistisches Löschen mit 5-Sekunden-Undo, für Einzel- und Mehrfachauswahl.
// Die Wiederherstellung hängt die Dokumente einfach zurück in `allDocuments` —
// die Reihenfolge stellt applyFilters() über die aktive Sortierung wieder her
// (früher wurde hier fest nach Namen sortiert, was die Datums-Sortierung des
// Servers zerschoss).
function deleteDocuments(docs) {
  if (!docs.length) return;
  const ids = new Set(docs.map((doc) => doc.id));
  const owner = _container;
  state.allDocuments = state.allDocuments.filter((doc) => !ids.has(doc.id));
  applyFilters();
  renderAll();

  const restore = () => {
    state.allDocuments = [...state.allDocuments, ...docs];
    applyFilters();
    renderAll();
  };

  const message = docs.length === 1
    ? t('documents.deletedToast')
    : t('documents.bulkDeletedToast', { count: docs.length });
  scheduleUndoableDelete({
    message,
    commit: async ({ keepalive }) => {
      await Promise.all(docs.map((doc) => api.delete(`/documents/${doc.id}`, { keepalive })));
      // Seite inzwischen verlassen: die Löschung ist durch, aber es gibt nichts
      // mehr zu zeichnen — kein Nachladen auf einen abgehängten Container.
      if (keepalive || _container !== owner) return;
      await loadDocuments();
      renderAll();
    },
    restore: (err) => {
      if (_container !== owner) return;
      restore();
      if (err) window.yuvomi?.showToast(err.data?.error ?? t('common.unknownError'), 'danger');
    },
  });
}

// --------------------------------------------------------
// Auswahl-Modus (opt-in Bulk) — folgt der Kontakte-Grammatik
// --------------------------------------------------------

function enterSelectMode() {
  state.selectMode = true;
  state.selected.clear();
  _container.querySelector('#documents-select-btn')?.setAttribute('aria-pressed', 'true');
  const bar = _container.querySelector('#documents-selectbar');
  if (bar) bar.hidden = false;
  renderDocuments();
  updateSelectUI();
}

function exitSelectMode() {
  if (!state.selectMode) return;
  state.selectMode = false;
  state.selected.clear();
  _container.querySelector('#documents-select-btn')?.setAttribute('aria-pressed', 'false');
  const bar = _container.querySelector('#documents-selectbar');
  if (bar) bar.hidden = true;
  renderDocuments();
}

function updateSelectUI() {
  const n = state.selected.size;
  const countEl = _container.querySelector('#documents-select-count');
  if (countEl) countEl.textContent = t('documents.selectCount', { count: n });
  _container.querySelectorAll('#documents-selectbar [data-action^="select-"]').forEach((btn) => {
    if (btn.dataset.action === 'select-cancel' || btn.dataset.action === 'select-all') return;
    btn.disabled = n === 0;
  });
}

function selectedDocuments() {
  return state.allDocuments.filter((doc) => state.selected.has(doc.id));
}

function toggleSelectAll() {
  const visible = filteredDocuments();
  const allOn = visible.length > 0 && visible.every((doc) => state.selected.has(doc.id));
  visible.forEach((doc) => (allOn ? state.selected.delete(doc.id) : state.selected.add(doc.id)));
  renderDocuments();
  updateSelectUI();
}

async function archiveSelected() {
  const docs = selectedDocuments();
  if (!docs.length) return;
  // Die aktive Status-Ansicht bestimmt die Richtung: im Archiv wiederherstellen,
  // sonst archivieren. Kein gemischter Zustand möglich, da beides nie zugleich sichtbar ist.
  const archived = state.status === 'archived';
  exitSelectMode();
  try {
    await Promise.all(docs.map((doc) => api.patch(`/documents/${doc.id}/archive`, { archived: !archived })));
    window.yuvomi?.showToast(
      archived
        ? t('documents.bulkRestoredToast', { count: docs.length })
        : t('documents.bulkArchivedToast', { count: docs.length }),
      'success',
    );
    await loadDocuments();
    renderAll();
  } catch (err) {
    window.yuvomi?.showToast(err.data?.error ?? t('common.unknownError'), 'danger');
  }
}

async function moveSelected() {
  const docs = selectedDocuments();
  if (!docs.length) return;
  const target = await selectModal(t('documents.moveToFolder'), [
    { value: '', label: t('documents.noFolder') },
    ...state.folders.map((folder) => ({ value: String(folder.id), label: folder.name })),
  ]);
  if (target === null) return;
  exitSelectMode();
  try {
    await Promise.all(docs.map((doc) => api.put(`/documents/${doc.id}`, {
      name: doc.name,
      description: doc.description || null,
      category: doc.category,
      folder_id: target || null,
      visibility: doc.visibility,
      status: doc.status,
      allowed_member_ids: doc.allowed_member_ids || [],
    })));
    window.yuvomi?.showToast(t('documents.bulkMovedToast', { count: docs.length }), 'success');
    await loadDocuments();
    renderAll();
    refocusAfterRender();
  } catch (err) {
    window.yuvomi?.showToast(err.data?.error ?? t('common.unknownError'), 'danger');
  }
}

async function deleteSelected() {
  const docs = selectedDocuments();
  if (!docs.length) return;
  const confirmed = await confirmModal(
    t('documents.bulkDeleteConfirm', { count: docs.length }),
    { danger: true, confirmLabel: t('common.delete'), detail: t('documents.bulkDeleteConfirmDetail') },
  );
  if (!confirmed) return;
  exitSelectMode();
  deleteDocuments(docs);
}

function memberOptions(selected = []) {
  const selectedSet = new Set(selected.map(String));
  return state.members.map((member) => `
    <label class="document-member-option">
      <input type="checkbox" value="${member.id}" ${selectedSet.has(String(member.id)) ? 'checked' : ''}>
      <span>${esc(member.display_name)}</span>
    </label>
  `).join('');
}

function openDocumentModal(doc = null, { initialUpload = 'files' } = {}) {
  const isEdit = !!doc;
  let modalPanel = null;

  // Kontextbezogener Upload: ist im Browser ein echter Ordner gewählt, wird er
  // im Modal vorausgewählt (weiterhin änderbar). „Alle Ordner"/„Kein Ordner"
  // (leer bzw. __none) setzen keinen Zielordner.
  const presetFolderId = (!isEdit && state.folderId && state.folderId !== '__none')
    ? String(state.folderId)
    : String(doc?.folder_id || '');

  // Nur noch echte Sekundärfelder liegen im Akkordeon. Die Sichtbarkeit ist das
  // beworbene Kernversprechen des Moduls („steuere, wer jede Datei sehen darf")
  // und steht deshalb offen im Formular, nicht zugeklappt darunter.
  const advancedOpen = isEdit && (!!doc.description || doc.status === 'archived');

  const advancedFieldsHtml = `
        <div class="form-group">
          <label class="label" for="document-description">${t('documents.descriptionLabel')}</label>
          <textarea class="input" id="document-description" rows="3" maxlength="5000">${esc(doc?.description || '')}</textarea>
        </div>
        <div class="form-group">
          <label class="label" for="document-status">${t('documents.statusLabel')}</label>
          <select class="input" id="document-status">
            <option value="active" ${doc?.status !== 'archived' ? 'selected' : ''}>${t('documents.statusActive')}</option>
            <option value="archived" ${doc?.status === 'archived' ? 'selected' : ''}>${t('documents.statusArchived')}</option>
          </select>
        </div>`;

  // Beim Anlegen kommt die Datei zuerst: sie ist das Objekt der Handlung und
  // liefert den Namen. Beim Bearbeiten gibt es keine Datei, dort führt der Name.
  const fileFieldHtml = `
        <div class="form-group">
          <label class="label" for="document-file">${t('documents.fileLabel')}</label>
          <div class="document-upload-choices" role="group" aria-label="${esc(t('documents.folderUpload.choiceLabel'))}">
            <label class="btn btn--secondary document-upload-choice" for="document-file">
              <i data-lucide="files" aria-hidden="true"></i>
              <span>${t('documents.folderUpload.chooseFiles')}</span>
            </label>
            <label class="btn btn--secondary document-upload-choice" id="document-folder-choice" for="document-folder-input">
              <i data-lucide="folder-up" aria-hidden="true"></i>
              <span>${t('documents.folderUpload.chooseFolder')}</span>
            </label>
            <input class="sr-only" id="document-folder-input" type="file" webkitdirectory>
          </div>
          <p class="document-form__hint" id="document-folder-unsupported" hidden>${t('documents.folderUpload.unsupportedBrowser')}</p>
          <label class="document-dropzone" id="document-dropzone" for="document-file">
            <input class="sr-only" id="document-file" type="file" multiple
                   ${state.allowedMimeTypes?.length ? `accept="${esc(state.allowedMimeTypes.join(','))}"` : ''}>
            <span class="document-dropzone__icon">
              <i data-lucide="file-up" aria-hidden="true"></i>
            </span>
            <span class="document-dropzone__title">${t('documents.dropzoneTitle')}</span>
            <span class="document-dropzone__hint">${t('documents.dropzoneHint')}</span>
            <span class="document-dropzone__file" id="document-selected-file" hidden></span>
          </label>
          <p class="document-form__hint">${t('documents.fileHint', { size: effectiveUploadMb() })}</p>
          <p class="document-form__hint">${t('documents.folderUpload.limitHint', { size: effectiveUploadMb() })}</p>
          <p class="document-storage-target">
            <i data-lucide="${uploadTargetIcon(state.activeUploadBackend)}" aria-hidden="true"></i>
            <span>${t('documents.activeUploadTarget', {
              target: uploadBackendLabel(state.activeUploadBackend),
            })}</span>
            ${state.isAdmin ? `<a class="document-storage-target__link" href="/settings/sync/storage" data-nav>${t('documents.storageSettingsLink')}</a>` : ''}
          </p>
          <section class="folder-upload-preview" id="document-folder-upload-preview" aria-live="polite" hidden></section>
        </div>`;

  openSharedModal({
    title: isEdit ? t('documents.editTitle') : t('documents.newTitle'),
    size: 'lg',
    content: `
      <form id="document-form" class="document-form">
        ${isEdit ? '' : fileFieldHtml}
        <div class="modal-grid modal-grid--2">
          <div class="form-group">
            <label class="label" for="document-name">${t('documents.nameLabel')}</label>
            <input class="input" id="document-name" name="name" maxlength="200" value="${esc(doc?.name || '')}"
                   ${isEdit ? 'required' : `placeholder="${esc(t('documents.namePlaceholder'))}"`}>
            ${isEdit ? '' : `<p class="document-form__hint" id="document-name-hint">${t('documents.nameHint')}</p>`}
          </div>
          <div class="form-group">
            <label class="label" for="document-category">${t('documents.categoryLabel')}</label>
            <select class="input" id="document-category">
              ${CATEGORIES.map((category) => `<option value="${category}" ${(doc?.category || 'other') === category ? 'selected' : ''}>${categoryLabels()[category]}</option>`).join('')}
            </select>
          </div>
          <div class="form-group">
            <label class="label" for="document-folder">${t('documents.folderLabel')}</label>
            <select class="input" id="document-folder">
              <option value="">${t('documents.noFolder')}</option>
              ${state.folders.map((folder) => `<option value="${folder.id}" ${presetFolderId === String(folder.id) ? 'selected' : ''}>${esc(folder.name)}</option>`).join('')}
            </select>
          </div>
          <div class="form-group"${isSoloHousehold() ? ' hidden' : ''}>
            <label class="label" for="document-visibility">${t('documents.visibilityLabel')}</label>
            <select class="input" id="document-visibility">
              <option value="family" ${(doc?.visibility || 'family') === 'family' ? 'selected' : ''}>${t('documents.visibility.family')}</option>
              <option value="restricted" ${doc?.visibility === 'restricted' ? 'selected' : ''}>${t('documents.visibility.restricted')}</option>
              <option value="private" ${doc?.visibility === 'private' ? 'selected' : ''}>${t('documents.visibility.private')}</option>
            </select>
          </div>
        </div>
        <div class="document-member-picker" id="document-member-picker">
          <div class="label">${t('documents.allowedMembersLabel')}</div>
          <div class="document-member-picker__grid">${memberOptions(doc?.allowed_member_ids || [])}</div>
        </div>
        ${advancedSection(advancedFieldsHtml, { open: advancedOpen })}
        <div id="document-error" class="form-error" role="alert" hidden></div>
        <div class="modal-panel__footer modal-panel__footer--plain">
          <button type="submit" class="btn btn--primary" id="document-submit">${isEdit ? t('common.save') : t('documents.uploadAction')}</button>
        </div>
      </form>
    `,
    onClose() {
      requestFolderUploadCancel(modalPanel);
    },
    onSave(panel) {
      modalPanel = panel;
      const form = panel.querySelector('#document-form');
      const visibility = panel.querySelector('#document-visibility');
      const picker = panel.querySelector('#document-member-picker');
      const syncVisibility = () => { picker.hidden = visibility.value !== 'restricted'; };
      visibility.addEventListener('change', syncVisibility);
      syncVisibility();
      bindDropzone(panel);
      const directorySupported = bindFolderUpload(panel);
      form.addEventListener('submit', (event) => saveDocument(event, doc, panel));
      // Die sichtbare Seitenaktion „Ordner hochladen" bewahrt die direkte
      // Nutzeraktivierung bis zum nativen Verzeichnis-Picker. Kein Timeout:
      // Browser dürfen einen verzögerten programmatic click als Popup blockieren.
      if (!isEdit && initialUpload === 'folder' && directorySupported) {
        const folderInput = panel.querySelector('#document-folder-input');
        folderInput.click();
      }
    },
  });
}

function bindDropzone(panel) {
  const dropzone = panel.querySelector('#document-dropzone');
  const input = panel.querySelector('#document-file');
  const selected = panel.querySelector('#document-selected-file');
  const nameField = panel.querySelector('#document-name');
  if (!dropzone || !input || !selected) return;

  // Bei mehreren Dateien trägt jede ihren eigenen Dateinamen; ein gemeinsames
  // Namensfeld wäre dann sinnlos und wird ausgeblendet.
  const syncSelectedFile = () => {
    const files = Array.from(input.files || []);
    selected.hidden = !files.length;
    selected.textContent = files.length === 1
      ? t('documents.selectedFileLabel', { name: files[0].name })
      : files.length > 1
        ? t('documents.selectedFilesLabel', { count: files.length })
        : '';
    const group = nameField?.closest('.form-group');
    if (group) group.hidden = files.length > 1;
  };

  input.addEventListener('change', syncSelectedFile);
  ['dragenter', 'dragover'].forEach((eventName) => {
    dropzone.addEventListener(eventName, (event) => {
      event.preventDefault();
      dropzone.classList.add('document-dropzone--active');
    });
  });
  ['dragleave', 'drop'].forEach((eventName) => {
    dropzone.addEventListener(eventName, (event) => {
      event.preventDefault();
      dropzone.classList.remove('document-dropzone--active');
    });
  });
  dropzone.addEventListener('drop', (event) => {
    if (input.disabled) return;
    const files = Array.from(event.dataTransfer?.files || []);
    if (!files.length) return;
    const transfer = new DataTransfer();
    files.forEach((file) => transfer.items.add(file));
    input.files = transfer.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

const FOLDER_UPLOAD_REASON_KEYS = {
  'missing-relative-path': 'documents.folderUpload.reasonMissingPath',
  'unsafe-path': 'documents.folderUpload.reasonUnsafePath',
  'empty-file': 'documents.folderUpload.reasonEmptyFile',
  'unsupported-type': 'documents.folderUpload.reasonUnsupportedType',
  'too-large': 'documents.folderUpload.reasonTooLarge',
  'name-too-long': 'documents.folderUpload.reasonNameTooLong',
  'too-deep': 'documents.folderUpload.reasonTooDeep',
  'parent-failed': 'documents.folderUpload.reasonParentFailed',
  'rate-limited': 'documents.folderUpload.reasonRateLimited',
};

function folderUploadReason(reason) {
  const key = FOLDER_UPLOAD_REASON_KEYS[reason];
  return key ? t(key) : (reason || t('common.unknownError'));
}

async function loadUploadConflictDocuments() {
  const counterpartStatus = state.status === 'active' ? 'archived' : 'active';
  const counterpart = await api.get(`/documents?status=${counterpartStatus}`);
  const byId = new Map();
  for (const doc of [...state.allDocuments, ...(counterpart.data || [])]) byId.set(doc.id, doc);
  return [...byId.values()];
}

function folderUploadTargetId(form) {
  const value = Number(form.querySelector('#document-folder')?.value);
  return Number.isInteger(value) && value > 0 ? value : null;
}

function effectiveUploadMb() {
  return Math.max(1, Math.floor((state.maxFileSize || maxUploadBytes()) / (1024 * 1024)));
}

function folderUploadChoiceOptions(value, firstValue, firstLabel, secondValue, secondLabel) {
  return `
    <option value="${firstValue}" ${value === firstValue ? 'selected' : ''}>${firstLabel}</option>
    <option value="${secondValue}" ${value === secondValue ? 'selected' : ''}>${secondLabel}</option>`;
}

function folderUploadTreeHtml(plan) {
  const rows = [
    ...plan.folders.map((folder) => ({
      path: folder.key,
      depth: folder.key.split('/').length,
      icon: folder.action === 'reuse' ? 'folder-check' : 'folder-plus',
      label: folder.name,
      status: folder.action === 'reuse' ? t('documents.folderUpload.willMerge') : t('documents.folderUpload.willCreate'),
      kind: 'folder',
    })),
    ...plan.files.filter((file) => file.action !== 'reject').map((file) => ({
      path: file.relativePath,
      depth: file.relativePath.split('/').length,
      icon: file.action === 'skip' ? 'file-x' : 'file-up',
      label: file.uploadOriginalName,
      status: file.action === 'skip' ? t('documents.folderUpload.willSkip') : t('documents.folderUpload.willUpload'),
      kind: 'file',
    })),
  ].sort((a, b) => a.path.localeCompare(b.path, getLocale()) || (a.kind === 'folder' ? -1 : 1));

  return `<ul class="folder-upload-tree" role="list" aria-label="${esc(t('documents.folderUpload.treeLabel'))}">
    ${rows.map((row) => `
      <li class="folder-upload-tree__item folder-upload-tree__item--${row.kind}" role="listitem"
          style="--folder-upload-depth:${Math.min(row.depth - 1, 4)}"
          data-upload-path="${esc(row.path)}">
        <i data-lucide="${row.icon}" aria-hidden="true"></i>
        <span class="folder-upload-tree__name">${esc(row.label)}</span>
        <span class="folder-upload-tree__status">${esc(row.status)}</span>
      </li>`).join('')}
  </ul>`;
}

function renderFolderUploadPreview(panel) {
  const upload = panel._folderUpload;
  const form = panel.querySelector('#document-form');
  const host = panel.querySelector('#document-folder-upload-preview');
  if (!upload?.files?.length || !form || !host) {
    if (host) host.hidden = true;
    return null;
  }

  const plan = buildFolderUploadPlan(upload.files, {
    folders: state.folders,
    documents: upload.documents,
    targetFolderId: folderUploadTargetId(form),
    maxFileSize: state.maxFileSize || maxUploadBytes(),
    allowedMimeTypes: state.allowedMimeTypes || [],
    timestamp: upload.timestamp,
    folderDefault: upload.folderDefault,
    fileDefault: upload.fileDefault,
    folderOverrides: upload.folderOverrides,
  });
  upload.plan = plan;
  host.hidden = false;
  host.replaceChildren();
  host.insertAdjacentHTML('beforeend', `
    <div class="folder-upload-preview__summary">
      <strong>${esc(t('documents.folderUpload.previewTitle', { name: plan.rootName }))}</strong>
      <span>${esc(t('documents.folderUpload.previewCounts', {
        files: plan.counts.upload,
        folders: plan.counts.createFolders,
        rejected: plan.counts.rejected,
      }))}</span>
    </div>
    ${folderUploadTreeHtml(plan)}
    ${plan.folderConflicts.length ? `
      <details class="folder-upload-preview__section" open>
        <summary>${t('documents.folderUpload.folderConflictsTitle', { count: plan.folderConflicts.length })}</summary>
        <label class="folder-upload-conflict__default">
          <span>${t('documents.folderUpload.defaultResolution')}</span>
          <select class="input" data-folder-conflict-default>
            ${folderUploadChoiceOptions(upload.folderDefault, 'merge', t('documents.folderUpload.merge'), 'duplicate', t('documents.folderUpload.duplicate'))}
          </select>
        </label>
        <div class="folder-upload-conflicts">
          ${plan.folderConflicts.map((folder) => `
            <label class="folder-upload-conflict">
              <span>${esc(folder.key)}</span>
              <select class="input" data-folder-conflict-key="${esc(folder.key)}">
                ${folderUploadChoiceOptions(folder.resolution, 'merge', t('documents.folderUpload.merge'), 'duplicate', t('documents.folderUpload.duplicate'))}
              </select>
            </label>`).join('')}
        </div>
      </details>` : ''}
    ${plan.fileConflicts.length ? `
      <details class="folder-upload-preview__section" open>
        <summary>${t('documents.folderUpload.fileConflictsTitle', { count: plan.fileConflicts.length })}</summary>
        <label class="folder-upload-conflict__default">
          <span>${t('documents.folderUpload.defaultResolution')}</span>
          <select class="input" data-file-conflict-default>
            ${folderUploadChoiceOptions(upload.fileDefault, 'skip', t('documents.folderUpload.skip'), 'duplicate', t('documents.folderUpload.duplicate'))}
          </select>
        </label>
        <div class="folder-upload-conflicts">
          ${plan.fileConflicts.map((file) => `
            <div class="folder-upload-conflict">
              <span>${esc(file.relativePath)}</span>
              <span>${esc(file.resolution === 'skip'
                ? t('documents.folderUpload.willSkip')
                : t('documents.folderUpload.willUpload'))}</span>
            </div>`).join('')}
        </div>
      </details>` : ''}
    ${plan.rejected.length ? `
      <details class="folder-upload-preview__section folder-upload-rejected" open>
        <summary>${t('documents.folderUpload.rejectedTitle', { count: plan.rejected.length })}</summary>
        <ul>
          ${plan.rejected.map((file) => `<li><span>${esc(file.relativePath)}</span><span>${esc(folderUploadReason(file.reason))}</span></li>`).join('')}
        </ul>
      </details>` : ''}
    <p class="folder-upload-preview__limit">${esc(t('documents.folderUpload.adminLimitHint', { size: effectiveUploadMb() }))}</p>
    <div class="folder-upload-progress" id="folder-upload-progress" aria-live="polite"></div>
    <button class="btn btn--secondary" type="button" data-folder-upload-cancel hidden>${t('common.cancel')}</button>
  `);
  if (window.lucide) lucide.createIcons({ el: host });

  const submit = panel.querySelector('#document-submit');
  if (submit) submit.textContent = t('documents.folderUpload.uploadAction', { count: plan.counts.upload });
  return plan;
}

function canPickDirectory() {
  const input = document.createElement('input');
  input.type = 'file';
  const hasWebkitDirectory = 'webkitdirectory' in input;
  if (hasWebkitDirectory) input.webkitdirectory = true;
  return supportsDirectoryUpload({
    hasWebkitDirectory: hasWebkitDirectory && input.webkitdirectory === true,
    platform: navigator.userAgentData?.platform || navigator.platform || '',
    userAgent: navigator.userAgent || '',
    maxTouchPoints: navigator.maxTouchPoints || 0,
  });
}

function setFolderUploadControlsDisabled(panel, disabled) {
  for (const selector of [
    '#document-file',
    '#document-folder-input',
    '#document-folder',
    '[data-folder-conflict-default]',
    '[data-file-conflict-default]',
    '[data-folder-conflict-key]',
  ]) {
    panel.querySelectorAll(selector).forEach((control) => {
      control.disabled = disabled;
    });
  }
}

function requestFolderUploadCancel(panel) {
  const upload = panel?._folderUpload;
  if (!upload?.running || upload.cancelled) return false;
  upload.cancelled = true;
  const cancel = panel.querySelector('[data-folder-upload-cancel]');
  if (cancel) {
    cancel.disabled = true;
    cancel.setAttribute('aria-disabled', 'true');
  }
  return true;
}

function bindFolderUpload(panel) {
  const form = panel.querySelector('#document-form');
  const fileInput = panel.querySelector('#document-file');
  const folderInput = panel.querySelector('#document-folder-input');
  const folderChoice = panel.querySelector('#document-folder-choice');
  const unsupported = panel.querySelector('#document-folder-unsupported');
  const preview = panel.querySelector('#document-folder-upload-preview');
  const selected = panel.querySelector('#document-selected-file');
  const nameGroup = panel.querySelector('#document-name')?.closest('.form-group');
  if (!form || !fileInput || !folderInput || !preview) return false;

  panel._folderUpload = {
    files: [],
    documents: [],
    timestamp: formatFolderUploadTimestamp(),
    folderDefault: 'merge',
    fileDefault: 'skip',
    folderOverrides: {},
    plan: null,
    ready: false,
    running: false,
    cancelled: false,
    completed: false,
  };

  const directorySupported = canPickDirectory();
  folderInput.disabled = !directorySupported;
  folderChoice?.classList.toggle('is-disabled', !directorySupported);
  folderChoice?.setAttribute('aria-disabled', String(!directorySupported));
  if (unsupported) unsupported.hidden = directorySupported;

  fileInput.addEventListener('change', () => {
    if (panel._folderUpload.running) return;
    if (!fileInput.files?.length) return;
    folderInput.value = '';
    panel._folderUpload.files = [];
    panel._folderUpload.plan = null;
    panel._folderUpload.ready = false;
    preview.hidden = true;
    const submit = panel.querySelector('#document-submit');
    if (submit) {
      submit.disabled = false;
      submit.textContent = t('documents.uploadAction');
    }
  });

  folderInput.addEventListener('change', async () => {
    if (panel._folderUpload.running) return;
    const files = Array.from(folderInput.files || []);
    if (!files.length) return;
    fileInput.value = '';
    panel._folderUpload.files = files;
    panel._folderUpload.timestamp = formatFolderUploadTimestamp();
    panel._folderUpload.folderOverrides = {};
    panel._folderUpload.ready = false;
    panel._folderUpload.completed = false;
    const submit = panel.querySelector('#document-submit');
    if (submit) submit.disabled = true;
    if (nameGroup) nameGroup.hidden = true;
    if (selected) {
      const root = String(files[0].webkitRelativePath || '').split('/')[0];
      selected.hidden = false;
      selected.textContent = t('documents.folderUpload.selectedFolder', { name: root, count: files.length });
    }
    try {
      panel._folderUpload.documents = await loadUploadConflictDocuments();
      panel._folderUpload.ready = true;
      renderFolderUploadPreview(panel);
      if (submit) submit.disabled = false;
    } catch (error) {
      const formError = form.querySelector('#document-error');
      formError.textContent = friendlyError(error);
      formError.hidden = false;
    }
  });

  form.querySelector('#document-folder')?.addEventListener('change', () => {
    if (panel._folderUpload.running) return;
    if (panel._folderUpload.files.length) renderFolderUploadPreview(panel);
  });

  preview.addEventListener('change', (event) => {
    if (panel._folderUpload.running) return;
    const target = event.target;
    if (target.matches('[data-folder-conflict-default]')) {
      panel._folderUpload.folderDefault = target.value;
      panel._folderUpload.folderOverrides = {};
    } else if (target.matches('[data-file-conflict-default]')) {
      panel._folderUpload.fileDefault = target.value;
    } else if (target.matches('[data-folder-conflict-key]')) {
      panel._folderUpload.folderOverrides[target.dataset.folderConflictKey] = target.value;
    } else {
      return;
    }
    renderFolderUploadPreview(panel);
  });

  preview.addEventListener('click', (event) => {
    if (event.target.closest('[data-folder-upload-close]')) closeModal({ force: true });
    const cancel = event.target.closest('[data-folder-upload-cancel]');
    if (cancel) requestFolderUploadCancel(panel);
  });

  return directorySupported;
}

function updateFolderUploadProgress(panel, event, completed, total) {
  const host = panel.querySelector('#folder-upload-progress');
  if (!host) return;
  const path = event.item?.relativePath || event.item?.key || event.item?.name || '';
  host.textContent = t('documents.folderUpload.progress', { current: completed, total, name: path });
  const row = Array.from(panel.querySelectorAll('[data-upload-path]'))
    .find((item) => item.dataset.uploadPath === path);
  if (row) row.dataset.uploadStatus = event.status;
}

function renderFolderUploadResult(panel, plan, result) {
  const host = panel.querySelector('#document-folder-upload-preview');
  if (!host) return;
  const failures = result.failed || [];
  const outcome = folderUploadOutcome(result);
  const heading = outcome.heading === 'cancelled'
    ? t('documents.folderUpload.cancelled')
    : outcome.heading === 'completedWithErrors'
      ? t('documents.folderUpload.completedWithErrors')
      : t('documents.folderUpload.completed');
  host.replaceChildren();
  host.insertAdjacentHTML('beforeend', `
    <div class="folder-upload-result" role="status">
      <h3>${heading}</h3>
      <p>${t('documents.folderUpload.resultCounts', {
        uploaded: result.uploaded.length,
        skipped: result.skipped.length,
        rejected: result.rejected.length,
        failed: failures.length,
      })}</p>
      ${result.cancelled ? `<p>${t('documents.folderUpload.cancelledDetail')}</p>` : ''}
      ${failures.length ? `
        <section class="folder-upload-result__failures">
          <h4>${t('documents.folderUpload.failedTitle')}</h4>
          <ul>${failures.map((failure) => `
            <li><span>${esc(failure.item?.relativePath || failure.item?.key || '')}</span><span>${esc(folderUploadReason(failure.reason))}</span></li>`).join('')}</ul>
        </section>` : ''}
      ${plan.rejected.length ? `
        <section class="folder-upload-result__failures">
          <h4>${t('documents.folderUpload.rejectedTitle', { count: plan.rejected.length })}</h4>
          <ul>${plan.rejected.map((file) => `<li><span>${esc(file.relativePath)}</span><span>${esc(folderUploadReason(file.reason))}</span></li>`).join('')}</ul>
        </section>` : ''}
      <button class="btn btn--primary" type="button" data-folder-upload-close>${t('common.close')}</button>
    </div>`);
}

async function saveFolderUpload(panel, payload) {
  const upload = panel._folderUpload;
  if (!upload?.ready) throw new Error(t('common.unknownError'));
  const plan = renderFolderUploadPreview(panel);
  if (!plan || (plan.counts.upload < 1 && plan.counts.createFolders < 1)) {
    throw new Error(t('documents.folderUpload.noUploadableFiles'));
  }
  upload.running = true;
  upload.cancelled = false;
  setFolderUploadControlsDisabled(panel, true);
  const cancel = panel.querySelector('[data-folder-upload-cancel]');
  if (cancel) {
    cancel.hidden = false;
    cancel.disabled = false;
  }
  const total = plan.counts.createFolders + plan.counts.upload;
  let completed = 0;

  let result;
  try {
    result = await executeFolderUploadPlan(plan, {
      createFolder: async ({ name, parentId }) => {
        const response = await api.post('/documents/folders', { name, parent_id: parentId });
        return response.data;
      },
      uploadFile: async ({ file, folderId, name, originalName }) => api.post('/documents', {
        ...payload,
        folder_id: folderId,
        name,
        original_name: originalName,
        content_data: await readFileAsDataUrl(file),
      }),
      onProgress: (event) => {
        if (event.status === 'succeeded' || event.status === 'failed') completed += 1;
        updateFolderUploadProgress(panel, event, completed, total);
      },
      shouldCancel: () => upload.cancelled,
    });
  } finally {
    upload.running = false;
  }

  upload.completed = true;
  renderFolderUploadResult(panel, plan, result);
  try {
    await runRateLimitedOperation(
      () => Promise.all([loadFolders(), loadDocuments()]),
    );
    renderAll();
  } catch (refreshError) {
    // The writes have already completed. A failed refresh must not turn a
    // persisted upload into a reported upload failure.
    console.warn('[Documents] Folder upload refresh failed:', refreshError);
  }
  const outcome = folderUploadOutcome(result);
  const toast = outcome.toast === 'cancelled'
    ? t('documents.folderUpload.cancelled')
    : outcome.toast === 'completedWithErrors'
      ? t('documents.folderUpload.completedWithErrors')
      : t('documents.folderUpload.uploadedToast', { count: result.uploaded.length });
  window.yuvomi?.showToast(toast, outcome.tone);
  return result;
}

async function saveDocument(event, doc, panel) {
  event.preventDefault();
  const form = event.target;
  const error = form.querySelector('#document-error');
  // Die Fußzeile mit dem Submit-Button wird beim Öffnen ans Panel gehoben
  // (#543), liegt also außerhalb des Formular-DOM - deshalb über das Panel
  // referenzieren. form.querySelector fände hier null, und submit.disabled
  // würfe einen unbehandelten TypeError (→ generischer Fehler-Toast statt
  // Speichern).
  const submit = panel.querySelector('#document-submit');
  error.hidden = true;
  submit.disabled = true;
  try {
    const visibility = form.querySelector('#document-visibility').value;
    const payload = {
      name: form.querySelector('#document-name').value.trim(),
      description: form.querySelector('#document-description').value.trim() || null,
      category: form.querySelector('#document-category').value,
      folder_id: form.querySelector('#document-folder').value || null,
      visibility,
      status: form.querySelector('#document-status').value,
      allowed_member_ids: visibility === 'restricted'
        ? Array.from(form.querySelectorAll('.document-member-picker input:checked')).map((input) => Number(input.value))
        : [],
    };
    if (doc) {
      if (!payload.name) throw new Error(t('common.required'));
      await api.put(`/documents/${doc.id}`, payload);
      window.yuvomi?.showToast(t('documents.savedToast'), 'success');
    } else {
      const folderFiles = Array.from(form.querySelector('#document-folder-input')?.files || []);
      if (folderFiles.length) {
        await saveFolderUpload(panel, payload);
        return;
      }
      const files = Array.from(form.querySelector('#document-file').files || []);
      if (!files.length) throw new Error(t('documents.fileRequired'));
      const maxSize = state.maxFileSize || maxUploadBytes();
      const tooBig = files.find((file) => file.size > maxSize);
      if (tooBig) throw new Error(t('documents.fileTooLargeNamed', { name: tooBig.name }));

      // Fortschritt sichtbar machen: das Einlesen einer mehrere MB großen Datei
      // als Data-URL dauert spürbar, und bei Mehrfachauswahl erst recht. Ein
      // stumm deaktivierter Knopf ließ das wie ein Hänger aussehen.
      const originalLabel = submit.textContent;
      for (const [index, file] of files.entries()) {
        submit.textContent = files.length > 1
          ? t('documents.uploadProgress', { current: index + 1, total: files.length })
          : originalLabel;
        // Der Name aus dem Feld gilt nur, wenn genau eine Datei hochgeladen wird;
        // sonst trägt jede Datei ihren eigenen (das Feld ist dann ausgeblendet).
        const name = files.length === 1 && payload.name
          ? payload.name
          : file.name.replace(/\.[^.]+$/, '');
        await api.post('/documents', {
          ...payload,
          name,
          original_name: file.name,
          content_data: await readFileAsDataUrl(file),
        });
      }
      submit.textContent = originalLabel;
      window.yuvomi?.showToast(
        files.length > 1
          ? t('documents.bulkUploadedToast', { count: files.length })
          : t('documents.uploadedToast'),
        'success',
      );
    }
    closeModal({ force: true });
    await loadDocuments();
    renderAll();
    refocusAfterRender();
  } catch (err) {
    error.textContent = friendlyError(err);
    error.hidden = false;
  } finally {
    submit.disabled = panel._folderUpload?.completed === true;
  }
}

/**
 * Neuer Ordner, auf Wunsch unter einem bestimmten.
 *
 * `parentId` kommt aus dem Menue "Unterordner anlegen"; ohne Angabe steht die
 * Auswahl auf dem gerade geoeffneten Ordner. DAS IST DER HAEUFIGE FALL und
 * nicht die Wurzel: wer in "Wohnung" steht und einen Ordner anlegt, meint fast
 * immer einen darin. Die Auswahl bleibt sichtbar, damit die Voreinstellung
 * eine Ansage ist und keine Ueberraschung.
 */
function openFolderModal({ parentId = null } = {}) {
  const preselected = parentId ?? (Number.isInteger(Number(state.folderId)) && Number(state.folderId) > 0
    ? Number(state.folderId)
    : null);
  const options = visibleAllFolderRows()
    .map((row) => `<option value="${row.folder.id}" ${row.folder.id === preselected ? 'selected' : ''}>${esc(`${'  '.repeat(row.depth)}${row.folder.name}`)}</option>`)
    .join('');

  openSharedModal({
    title: t('documents.newFolderTitle'),
    size: 'sm',
    content: `
      <form id="document-folder-form" class="document-form">
        <div class="form-group">
          <label class="label" for="document-folder-name">${t('documents.folderNameLabel')}</label>
          <input class="input" id="document-folder-name" required maxlength="200" autocomplete="off">
        </div>
        <div class="form-group">
          <label class="label" for="document-folder-parent">${t('documents.folderParentLabel')}</label>
          <select class="input" id="document-folder-parent">
            <option value="" ${preselected === null ? 'selected' : ''}>${esc(t('documents.folderRootLevel'))}</option>
            ${options}
          </select>
        </div>
        <div id="document-folder-error" class="form-error" role="alert" hidden></div>
        <div class="modal-panel__footer modal-panel__footer--plain">
          <button type="submit" class="btn btn--primary">${t('documents.createFolderAction')}</button>
        </div>
      </form>
    `,
    onSave(panel) {
      panel.querySelector('#document-folder-form')?.addEventListener('submit', async (event) => {
        event.preventDefault();
        const error = panel.querySelector('#document-folder-error');
        const input = panel.querySelector('#document-folder-name');
        const parentSelect = panel.querySelector('#document-folder-parent');
        const parent = parentSelect.value ? Number(parentSelect.value) : null;
        error.hidden = true;
        try {
          const res = await api.post('/documents/folders', { name: input.value.trim(), parent_id: parent });
          // Der Elternteil wird aufgeklappt - ein neuer Ordner, den man nicht
          // sieht, sieht aus wie einer, der nicht angelegt wurde.
          if (parent !== null) {
            state.expanded.add(parent);
            persistExpandedFolders();
          }
          window.yuvomi?.showToast(t('documents.folderCreatedToast'), 'success');
          state.folderId = String(res.data?.id || '');
          await loadFolders();
          await loadDocuments();
          closeModal({ force: true });
          applyFilters();
          renderAll();
        } catch (err) {
          error.textContent = friendlyError(err);
          error.hidden = false;
        }
      });
    },
  });
}

// --------------------------------------------------------
// DMS Link Modal
// --------------------------------------------------------

function openDmsLinkModal() {
  if (!state.dmsAccounts.length) return;
  openSharedModal({
    title: t('documents.linkFromDms'),
    size: 'md',
    content: '<div id="dms-modal-root"></div>',
    onSave(panel) {
      const root = panel.querySelector('#dms-modal-root');
      if (!root) return;

      let selectedAccountId = state.dmsAccounts[0].id;

      // ASN-Hinweis ist Paperless-spezifisch (Discussion #511): nur einblenden,
      // wenn das aktive Konto ein Paperless-ngx ist (Papra kennt keine ASN).
      const providerOf = (id) => state.dmsAccounts.find((a) => String(a.id) === String(id))?.provider;
      const hint = document.createElement('p');
      hint.className = 'form-hint dms-search-hint';
      hint.textContent = t('documents.dmsAsnHint');
      const syncHint = () => { hint.hidden = providerOf(selectedAccountId) !== 'paperless'; };

      // Account selector — only render when multiple accounts exist
      if (state.dmsAccounts.length > 1) {
        const accountLabel = document.createElement('label');
        accountLabel.className = 'label';
        accountLabel.setAttribute('for', 'dms-account-select');
        accountLabel.textContent = t('documents.dmsAccountLabel');

        const accountSelect = document.createElement('select');
        accountSelect.className = 'input dms-account-select';
        accountSelect.id = 'dms-account-select';
        for (const account of state.dmsAccounts) {
          const option = document.createElement('option');
          option.value = account.id;
          option.textContent = account.name;
          accountSelect.appendChild(option);
        }

        accountSelect.addEventListener('change', () => {
          selectedAccountId = accountSelect.value;
          syncHint();
          // Re-run listing for the new account (empty query lists all documents).
          runDmsSearch(input.value.trim());
        });

        root.append(accountLabel, accountSelect);
      }

      // Sichtbares Label statt Placeholder-only: der Placeholder verschwindet beim
      // Tippen und ist kein Label-Ersatz für Screenreader.
      const searchLabel = document.createElement('label');
      searchLabel.className = 'label';
      searchLabel.setAttribute('for', 'dms-search');
      searchLabel.textContent = t('documents.dmsSearchLabel');

      const input = document.createElement('input');
      input.className = 'input';
      input.id = 'dms-search';
      input.type = 'search';
      input.placeholder = t('documents.dmsSearchPlaceholder');

      const results = document.createElement('ul');
      results.id = 'dms-results';
      results.className = 'dms-results';
      results.setAttribute('aria-busy', 'false');

      root.append(searchLabel, input, hint, results);
      syncHint();

      // Ein Netzwerk-/Serverfehler ist kein leeres Suchergebnis: der alte Code
      // zeigte für beides „Keine Treffer im DMS", sodass ein toter DMS-Server wie
      // ein leerer aussah. Fehler bekommen jetzt eigene Copy und einen Retry.
      const showSearchError = (q) => {
        results.replaceChildren();
        const li = document.createElement('li');
        li.className = 'dms-results__error';
        li.setAttribute('role', 'alert');
        const text = document.createElement('span');
        text.textContent = t('documents.dmsSearchError');
        const retry = document.createElement('button');
        retry.type = 'button';
        retry.className = 'btn btn--secondary btn--sm';
        retry.textContent = t('common.retry');
        retry.addEventListener('click', () => runDmsSearch(q));
        li.append(text, retry);
        results.appendChild(li);
      };

      const runDmsSearch = async (q) => {
        results.setAttribute('aria-busy', 'true');
        results.replaceChildren();
        const loading = document.createElement('li');
        loading.className = 'form-hint';
        loading.textContent = t('documents.dmsSearching');
        results.appendChild(loading);
        try {
          const res = await api.get(`/documents/dms/search?account_id=${selectedAccountId}&q=${encodeURIComponent(q)}`);
          renderDmsResults(results, res.data, selectedAccountId);
        } catch {
          showSearchError(q);
        } finally {
          results.setAttribute('aria-busy', 'false');
        }
      };

      let dmsSearchTimer;
      input.addEventListener('input', () => {
        clearTimeout(dmsSearchTimer);
        // Leere Eingabe listet alle Dokumente (statt zu leeren), damit der Nutzer
        // ohne exakte Suchbegriffe durchblättern kann (Issue #449).
        dmsSearchTimer = setTimeout(() => runDmsSearch(input.value.trim()), 300);
      });

      // Beim Öffnen bereits die volle Dokumentliste zeigen.
      runDmsSearch('');

      setTimeout(() => input.focus(), 60);
    },
  });
}

function renderDmsResults(container, items, accountId) {
  container.replaceChildren();
  if (!items || !items.length) {
    const li = document.createElement('li');
    li.className = 'form-hint';
    li.textContent = t('documents.dmsNoResults');
    container.appendChild(li);
    return;
  }
  const provider = state.dmsAccounts.find((a) => String(a.id) === String(accountId))?.provider;
  const supportsThumb = provider === 'paperless';
  for (const item of items) {
    const li = document.createElement('li');
    li.className = 'dms-result';

    // Vorschau (Issue #533, vergrößert in #536): Thumbnail der ersten Seite im
    // Seitenformat statt als Briefmarke, mit Glyph-Fallback. Ein Klick öffnet die
    // große Vorschau im Modal - erst dort entscheidet man, ob es das richtige
    // Dokument ist. Ohne Thumbnail bleibt es beim Direktlink ins DMS.
    const canOpen = /^https?:\/\//i.test(item.url || '');
    let media;
    if (supportsThumb) {
      media = document.createElement('button');
      media.type = 'button';
      media.className = 'dms-result__media dms-result__media--action';
      setMediaAffordance(media, t('documents.dmsPreviewOpen'));
      media.addEventListener('click', () => {
        const thumb = media.querySelector('img[data-thumb]');
        if (thumb && !thumb.hidden) {
          openDmsPreview({ item, src: thumb.src, canOpen, onLink: () => linkDmsDocument(item, accountId) });
        } else if (canOpen) {
          window.open(item.url, '_blank', 'noopener,noreferrer');
        }
      });
    } else if (canOpen) {
      media = document.createElement('a');
      media.className = 'dms-result__media dms-result__media--link';
      media.href = item.url;
      media.target = '_blank';
      media.rel = 'noopener noreferrer';
      setMediaAffordance(media, t('documents.dmsOpenExternal'));
    } else {
      media = document.createElement('span');
      media.className = 'dms-result__media';
    }
    media.insertAdjacentHTML('beforeend', `<span class="dms-result__glyph" data-thumb-icon><i data-lucide="file-text" aria-hidden="true"></i></span>`);
    if (supportsThumb) {
      const img = document.createElement('img');
      img.className = 'dms-result__thumb';
      img.dataset.thumb = '';
      img.loading = 'lazy';
      img.alt = '';
      img.width = 72;
      img.height = 96;
      img.hidden = true;
      img.src = `/api/v1/documents/dms/thumbnail?account_id=${encodeURIComponent(accountId)}&dms_document_id=${encodeURIComponent(item.id)}`;
      // Ohne Thumbnail gibt es nichts zu vergrößern: die Kachel fällt auf den
      // DMS-Direktlink zurück bzw. wird zur reinen Anzeige.
      img.addEventListener('error', () => {
        if (canOpen) setMediaAffordance(media, t('documents.dmsOpenExternal'));
        else {
          media.disabled = true;
          media.removeAttribute('title');
          media.removeAttribute('aria-label');
        }
      }, { once: true });
      media.appendChild(img);
    }
    if (supportsThumb || canOpen) {
      // Hover-Verrät: ein Lupen- bzw. Öffnen-Symbol taucht über der Vorschau auf.
      const glyph = supportsThumb ? 'zoom-in' : 'external-link';
      media.insertAdjacentHTML('beforeend', `<span class="dms-result__open" aria-hidden="true"><i data-lucide="${glyph}"></i></span>`);
    }

    const text = document.createElement('span');
    text.className = 'dms-result__text';
    const label = document.createElement('span');
    label.className = 'dms-result__title';
    label.textContent = item.title;
    text.appendChild(label);
    const typeLabel = fileTypeLabel(item.filename);
    const sub = [item.filename, typeLabel].filter((v) => v && v !== item.title).join(' · ');
    if (sub) {
      const subEl = document.createElement('span');
      subEl.className = 'dms-result__sub';
      subEl.textContent = sub;
      text.appendChild(subEl);
    }

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn btn--primary btn--sm';
    btn.textContent = t('documents.dmsLinkBtn');

    btn.addEventListener('click', async () => {
      btn.disabled = true;
      const ok = await linkDmsDocument(item, accountId);
      if (!ok) btn.disabled = false;
    });

    li.append(media, text, btn);
    container.appendChild(li);
  }
  if (window.lucide) lucide.createIcons({ el: container });
  wireThumbnails(container);
}

// Titel und Screenreader-Label einer Vorschaukachel gemeinsam setzen - beide
// beschreiben dieselbe Aktion und dürfen nie auseinanderlaufen.
function setMediaAffordance(el, label) {
  el.title = label;
  el.setAttribute('aria-label', label);
}

// Verknüpft ein DMS-Dokument mit der Dokumentenliste. Gibt true bei Erfolg zurück,
// damit der auslösende Button im Fehlerfall wieder bedienbar wird.
async function linkDmsDocument(item, accountId) {
  try {
    // Feste, vorhersagbare Kategorie: früher erbte das verknüpfte Dokument
    // stillschweigend das gerade aktive Filter-Chip, was nirgends stand.
    // Anpassen geht danach über „Bearbeiten".
    await api.post('/documents/dms/link', {
      account_id: accountId,
      dms_document_id: item.id,
      category: 'other',
      visibility: 'family',
    });
    closeModal({ force: true });
    await loadDocuments();
    renderAll();
    refocusAfterRender();
    return true;
  } catch (err) {
    window.yuvomi?.showToast(err.data?.error ?? t('common.unknownError'), 'danger');
    return false;
  }
}

// Große Vorschau über dem Auswahl-Modal (Issue #536): die Kachel in der Liste
// bleibt kompakt, das Dokument wird trotzdem lesbar geprüft, bevor man verknüpft.
// Bewusst kein zweites openModal - das Modal-System hält genau ein Overlay.
function openDmsPreview({ item, src, canOpen, onLink }) {
  const panel = document.querySelector('#shared-modal-overlay .modal-panel');
  if (!panel) return;
  const opener = document.activeElement;

  const layer = document.createElement('div');
  layer.className = 'dms-preview';
  layer.setAttribute('role', 'dialog');
  layer.setAttribute('aria-modal', 'true');
  layer.setAttribute('aria-label', item.title);

  const box = document.createElement('div');
  box.className = 'dms-preview__panel';

  const header = document.createElement('div');
  header.className = 'dms-preview__header';
  const heading = document.createElement('p');
  heading.className = 'dms-preview__title';
  heading.textContent = item.title;
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'dms-preview__close';
  close.setAttribute('aria-label', t('common.close'));
  close.insertAdjacentHTML('beforeend', '<i data-lucide="x" aria-hidden="true"></i>');
  header.append(heading, close);

  const figure = document.createElement('div');
  figure.className = 'dms-preview__figure';
  const img = document.createElement('img');
  img.className = 'dms-preview__img';
  img.src = src;
  img.alt = '';
  figure.appendChild(img);

  const actions = document.createElement('div');
  actions.className = 'dms-preview__actions';
  if (canOpen) {
    const open = document.createElement('a');
    open.className = 'btn btn--secondary';
    open.href = item.url;
    open.target = '_blank';
    open.rel = 'noopener noreferrer';
    open.textContent = t('documents.dmsOpenExternal');
    actions.appendChild(open);
  }
  const link = document.createElement('button');
  link.type = 'button';
  link.className = 'btn btn--primary';
  link.textContent = t('documents.dmsLinkBtn');
  link.addEventListener('click', async () => {
    link.disabled = true;
    const ok = await onLink();
    if (!ok) link.disabled = false;
  });
  actions.appendChild(link);

  box.append(header, figure, actions);
  layer.appendChild(box);

  const dismiss = () => {
    document.removeEventListener('keydown', onKey, true);
    layer.remove();
    opener?.focus?.();
  };
  // Wie bei Escape gilt fuer die Zurueck-Geste: sie schliesst zuerst die
  // Vorschau, nicht die Auswahl darunter (#871).
  attachOverlay(layer, dismiss);
  // Capture-Phase: das Modal schließt auf Escape über einen Listener am document.
  // Hier wird das Ereignis abgefangen, damit Escape zuerst nur die Vorschau
  // schließt und nicht gleich die ganze Auswahl wegräumt.
  const onKey = (e) => {
    if (e.key !== 'Escape') return;
    e.stopPropagation();
    dismiss();
  };
  document.addEventListener('keydown', onKey, true);
  close.addEventListener('click', dismiss);
  layer.addEventListener('click', (e) => { if (e.target === layer) dismiss(); });

  panel.appendChild(layer);
  if (window.lucide) lucide.createIcons({ el: layer });
  close.focus();
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error(t('documents.fileReadError')));
    reader.readAsDataURL(file);
  });
}

function formatFileSize(bytes) {
  // Fehlende/unbekannte Größe (z. B. DMS-verknüpfte Dokumente) → „—" statt „0 KB",
  // das wie ein leeres Dokument aussähe.
  if (bytes == null) return '—';
  if (!bytes) return '0 KB';
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// --------------------------------------------------------
// Document Viewer
// --------------------------------------------------------

function openDocumentViewer(doc) {
  const labels = categoryLabels();
  const previewUrl = `/api/v1/documents/${doc.id}/preview`;
  const downloadUrl = `/api/v1/documents/${doc.id}/download`;
  // Defense-in-Depth: nur http(s)-Deep-Links rendern, niemals javascript:/data:-Schemata
  // (zusätzlich zur serverseitigen base_url-Validierung bei der DMS-Account-Anlage).
  const externalUrl = documentStorageBackend(doc) === 'dms' && /^https?:\/\//i.test(doc.external_url || '')
    ? doc.external_url
    : '';

  // pdf.js-Viewer hält Worker + Dokument im Speicher; beim Schließen freigeben.
  let pdfTeardown = null;

  // Teilen über das Teilen-Menü des Geräts (D#1014). Ob es geht, steht beim
  // Öffnen fest - utils/web-share.js beantwortet Typ und Browser in einer
  // Probe, ohne ein Byte zu laden. Nur dann wird die Datei geholt, und zwar
  // im Hintergrund: der spätere Klick muss DIREKT in navigator.share() münden,
  // ein await zwischen Klick und share() verbraucht auf iOS die transiente
  // Nutzeraktivierung und das Teilen-Menü öffnet sich nicht. Wo Teilen nicht
  // geht, steht kein toter Knopf (#962), sondern eine Zeile, die sagt warum;
  // Download bleibt der Weg, der überall funktioniert. Die Zeile bekommt kein
  // Teilen: dort zählt der Klick sofort, und die Datei erst zu holen hieße
  // jede Zeile in den Speicher zu laden. Das ist die Form, die der Melder
  // selbst vorgeschlagen hat.
  const shareSupport = fileShareSupport(doc);
  const shareAbort = new AbortController();
  let shareFile = null;

  openSharedModal({
    title: doc.name,
    size: 'xl',
    content: `
      <div class="document-viewer">
        <div class="document-viewer__meta">
          <span><i data-lucide="${CATEGORY_ICONS[doc.category] || 'folder'}" aria-hidden="true"></i>${labels[doc.category] || doc.category}</span>
          ${doc.folder_name ? `<span><i data-lucide="folder" aria-hidden="true"></i>${esc(doc.folder_name)}</span>` : ''}
          <span>${formatFileSize(doc.file_size)}</span>
          <span class="document-viewer__actions">
            ${externalUrl ? `
            <a class="btn btn--ghost btn--sm doc-viewer__dms-link" href="${esc(externalUrl)}" target="_blank" rel="noopener noreferrer">
              <i data-lucide="external-link" class="icon-md" aria-hidden="true"></i>
              ${t('documents.dmsOpenExternal')}
            </a>` : ''}
            ${previewKind(doc.mime_type) === 'pdf' ? `
            <a class="btn btn--ghost btn--icon btn--icon-sm" href="${previewUrl}" target="_blank" rel="noopener noreferrer"
               title="${t('documents.viewerOpenInTab')}" aria-label="${t('documents.viewerOpenInTab')}">
              <i data-lucide="external-link" class="icon-md" aria-hidden="true"></i>
            </a>` : ''}
            ${shareSupport === 'ok' ? `
            <button type="button" class="btn btn--ghost btn--icon btn--icon-sm" data-action="share" disabled aria-busy="true"
               title="${t('documents.sharePreparing')}" aria-label="${t('documents.sharePreparing')}">
              <i data-lucide="share-2" class="icon-md" aria-hidden="true"></i>
            </button>` : ''}
            <a class="btn btn--primary btn--icon btn--icon-sm" href="${downloadUrl}" download
               title="${t('documents.downloadAction')}" aria-label="${t('documents.downloadAction')}">
              <i data-lucide="download" class="icon-md" aria-hidden="true"></i>
            </a>
          </span>
          ${shareSupport !== 'ok' ? `<p class="document-viewer__note">${t(shareSupport === 'type' ? 'documents.shareUnsupportedType' : 'documents.shareUnavailable')}</p>` : ''}
        </div>
        <div class="document-viewer__body" id="document-viewer-body">
          ${renderViewerContent(doc, previewUrl, downloadUrl)}
        </div>
      </div>
    `,
    onClose() {
      if (typeof pdfTeardown === 'function') pdfTeardown();
      shareAbort.abort();
      shareFile = null;
    },
    onSave(panel) {
      if (window.lucide) window.lucide.createIcons({ el: panel });
      if (shareSupport === 'ok') prepareShare(panel);
      // PDFs ohne nativen Inline-Viewer (mobile Browser): mit pdf.js auf Canvas rendern
      if (previewKind(doc.mime_type) === 'pdf' && !canRenderPdfNatively()) {
        const container = panel.querySelector('[data-pdf-pages]');
        pdfTeardown = renderPdfPages(container, previewUrl, doc, downloadUrl);
      }
      // Text-Dokumente: Inhalt asynchron laden
      if (previewKind(doc.mime_type) === 'text') {
        const body = panel.querySelector('#document-viewer-body');
        fetch(previewUrl, { credentials: 'same-origin' })
          .then((res) => res.text())
          .then((text) => {
            if (!body) return;
            body.replaceChildren();
            body.insertAdjacentHTML('beforeend', `<pre class="document-viewer__text">${esc(text)}</pre>`);
          })
          .catch(() => {
            if (!body) return;
            body.replaceChildren();
            body.insertAdjacentHTML('beforeend', renderViewerUnsupported(doc));
            if (window.lucide) window.lucide.createIcons({ el: body });
          });
      }
    },
  });

  // Datei im Hintergrund holen; der Knopf wird erst frei, wenn sie da ist.
  function prepareShare(panel) {
    const btn = panel.querySelector('[data-action="share"]');
    if (!btn) return;
    fetch(downloadUrl, { credentials: 'same-origin', signal: shareAbort.signal })
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.blob();
      })
      .then((blob) => {
        shareFile = new File([blob], doc.original_name || doc.name, { type: doc.mime_type });
        btn.disabled = false;
        btn.removeAttribute('aria-busy');
        btn.title = t('documents.shareAction');
        btn.setAttribute('aria-label', t('documents.shareAction'));
      })
      .catch((err) => {
        if (err?.name === 'AbortError') return;
        btn.remove();
        panel.querySelector('.document-viewer__meta')
          ?.insertAdjacentHTML('beforeend', `<p class="document-viewer__note">${t('documents.shareFailed')}</p>`);
      });
    // Kein await vor navigator.share(): canShare() ist synchron, die Datei
    // liegt schon vor - der Aufruf gehört noch zur Nutzeraktivierung.
    btn.addEventListener('click', () => {
      if (!shareFile) return;
      if (!navigator.canShare({ files: [shareFile] })) {
        window.yuvomi?.showToast(t('documents.shareFailed'), 'danger');
        return;
      }
      navigator.share({ files: [shareFile], title: doc.name }).catch((err) => {
        // AbortError: das Teilen-Menü wurde ohne Auswahl geschlossen - kein Fehler.
        if (err?.name === 'AbortError') return;
        window.yuvomi?.showToast(t('documents.shareFailed'), 'danger');
      });
    });
  }
}

function renderViewerContent(doc, previewUrl, downloadUrl) {
  const kind = previewKind(doc.mime_type);
  if (kind === 'pdf') {
    if (canRenderPdfNatively()) {
      // Kein `sandbox` am PDF-iframe: Chromium verweigert die Initialisierung seines internen
      // PDF-Viewers in sandboxed Frames und zeigt stattdessen "This page was blocked by Chrome".
      // Die Auslieferung erfolgt same-origin als application/pdf mit nosniff, daher keine
      // Skriptausführung im Frame.
      return `<iframe class="document-viewer__pdf" src="${previewUrl}" title="${esc(doc.name)}"></iframe>`;
    }
    // Mobile Browser (iOS Safari, Android Chrome) rendern PDFs in <iframe>/<embed> nicht inline.
    // Platzhalter; das eigentliche Rendern via pdf.js läuft asynchron im onSave-Hook.
    // Fokussierbare Region (role=region + tabindex) macht den Seitenstapel per Tastatur scrollbar.
    // Ehrliche Semantik: der Canvas-Render ist grafisch (keine Textebene) -> ein sr-only-Hinweis
    // verweist auf den vorlesbaren Weg (Meta-Leiste: "In neuem Tab öffnen"/Download), die
    // Seiten-Canvases selbst sind aria-hidden. data-pdf-live kündigt Ladeende/Fehler an.
    return `<div class="document-viewer__pdf-pages" data-pdf-pages tabindex="0" role="region" aria-label="${esc(doc.name)}">
      <p class="sr-only" data-pdf-note>${t('documents.viewerPdfA11yNote')}</p>
      <span class="sr-only" role="status" aria-live="polite" data-pdf-live></span>
      <div class="document-viewer__pdf-indicator" data-pdf-indicator aria-hidden="true" hidden></div>
      <div class="document-viewer__pdf-content" data-pdf-content>
        <div class="document-viewer__loading" role="status">
          <i data-lucide="loader-circle" class="document-viewer__spinner" aria-hidden="true"></i>
          <span data-pdf-loading-text>${t('documents.viewerPdfLoading')}</span>
        </div>
      </div>
    </div>`;
  }
  if (kind === 'image') {
    return `<img class="document-viewer__image" src="${previewUrl}" alt="${esc(doc.name)}"`
      + ` loading="lazy">`;
  }
  if (kind === 'text') {
    // Inhalt wird asynchron in onSave geladen; Platzhalter anzeigen
    return `<div class="document-viewer__loading" role="status">
      <i data-lucide="loader-circle" class="document-viewer__spinner" aria-hidden="true"></i>
      ${esc(doc.original_name)}
    </div>`;
  }
  // Nicht darstellbare Typen: Aktionen liegen in der Meta-Leiste (Download immer vorhanden)
  return renderViewerUnsupported(doc);
}

// Gemeinsamer Empty-State: Icon + Titel + Hinweis. Deckt nicht darstellbare Typen und den
// pdf.js-Renderfehler-Fallback ab. Die Aktionen (Download, für PDFs "In neuem Tab öffnen")
// liegen in der Meta-Leiste des Viewers und sind immer sichtbar -> keine doppelten Buttons hier.
// `alert` macht den Fehlerpfad als Live-Region für Screenreader hörbar.
function renderViewerFallback(doc, { hint, icon = 'file-x', alert = false } = {}) {
  return `
    <div class="document-viewer__unsupported"${alert ? ' role="alert"' : ''}>
      <span class="document-viewer__unsupported-icon">
        <i data-lucide="${icon}" aria-hidden="true"></i>
      </span>
      <div class="document-viewer__unsupported-title">${esc(doc.original_name)}</div>
      <div class="document-viewer__unsupported-hint">${hint}</div>
    </div>
  `;
}

function renderViewerUnsupported(doc) {
  return renderViewerFallback(doc, { hint: t('documents.viewerDownloadHint') });
}

// navigator.pdfViewerEnabled === true bedeutet, dass der Browser einen eingebauten
// Inline-PDF-Viewer besitzt (Desktop Chrome/Firefox/Safari). Mobile Safari/Chrome melden
// false; dort bleibt ein <iframe src=".pdf"> leer -> stattdessen pdf.js auf Canvas rendern.
// Bei undefined (ältere Browser) konservativ pdf.js nutzen, das überall funktioniert.
function canRenderPdfNatively() {
  return navigator.pdfViewerEnabled === true;
}

// Maximal gleichzeitig gehaltene gerenderte Seiten-Canvases (LRU). Begrenzt den Speicher
// auch bei sehr großen PDFs auf Mobilgeräten; nicht sichtbare Seiten fallen auf Platzhalter zurück.
const PDF_MAX_RENDERED = 6;

// Rendert ein PDF via gevendortem pdf.js seitenweise on demand (IntersectionObserver): nur
// sichtbare/nahe Seiten werden auf Canvas gezeichnet, entfernte per LRU wieder freigegeben.
// Gibt eine synchrone Teardown-Funktion zurück (Worker/Dokument freigeben, Observer trennen),
// die beim Schließen des Modals aufgerufen wird. Fällt bei Fehlern auf Tab/Download zurück.
function renderPdfPages(container, previewUrl, doc, downloadUrl) {
  const state = { destroyed: false, pdf: null, observer: null, resizeObs: null, resizeTimer: null };
  const teardown = () => {
    state.destroyed = true;
    if (state.observer) { state.observer.disconnect(); state.observer = null; }
    if (state.resizeObs) { state.resizeObs.disconnect(); state.resizeObs = null; }
    if (state.resizeTimer) { clearTimeout(state.resizeTimer); state.resizeTimer = null; }
    if (state.pdf) { try { state.pdf.destroy(); } catch (e) { /* already gone */ } state.pdf = null; }
  };
  if (!container) return teardown;

  // Live-Region + Slots aus der Markup-Vorlage (renderViewerContent).
  const content = container.querySelector('[data-pdf-content]') || container;
  const liveEl = container.querySelector('[data-pdf-live]');
  const indicatorEl = container.querySelector('[data-pdf-indicator]');
  const loadingTextEl = container.querySelector('[data-pdf-loading-text]');
  // Nur der Modal-Body scrollt (kein verschachtelter Scroller): Observer misst gegen ihn.
  const scrollRoot = container.closest('.modal-panel__body');

  const showFallback = () => {
    if (state.destroyed) return;
    if (indicatorEl) indicatorEl.hidden = true;
    content.replaceChildren();
    content.insertAdjacentHTML('beforeend', renderViewerFallback(doc, {
      hint: t('documents.viewerPdfFallbackHint'), icon: 'alert-triangle', alert: true,
    }));
    if (window.lucide) window.lucide.createIcons({ el: content });
  };

  (async () => {
    try {
      const pdfjs = await import('/vendor/pdfjs/pdf.min.mjs');
      if (state.destroyed) return;
      pdfjs.GlobalWorkerOptions.workerSrc = '/vendor/pdfjs/pdf.worker.min.mjs';
      const loadingTask = pdfjs.getDocument({
        url: previewUrl,
        withCredentials: true,
        // Kein eval/WASM: hält die App-CSP (script-src 'self') unangetastet.
        isEvalSupported: false,
        // Ohne diese Daten rendern PDFs mit nicht-eingebetteten Standard-Fonts
        // (Helvetica/Times/Courier) ohne Text.
        standardFontDataUrl: '/vendor/pdfjs/standard_fonts/',
      });
      // Fortschritt in die Ladeanzeige spiegeln (große/langsame Dateien).
      loadingTask.onProgress = (progress) => {
        if (state.destroyed || !loadingTextEl) return;
        const total = progress && progress.total;
        if (!total) return;
        const pct = Math.min(100, Math.round((progress.loaded / total) * 100));
        loadingTextEl.textContent = `${t('documents.viewerPdfLoading')} ${pct} %`;
      };
      const pdf = await loadingTask.promise;
      if (state.destroyed) { try { pdf.destroy(); } catch (e) { /* noop */ } return; }
      state.pdf = pdf;

      // Breite erst nach dem nächsten Frame messen (Modal-Einblendung braucht ein Layout).
      await new Promise((resolve) => requestAnimationFrame(resolve));
      if (state.destroyed) return;

      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      let renderWidth = Math.max(240, container.clientWidth || 600);

      // Aspektverhältnis der ersten Seite als Default für alle Platzhalter (reserviert Scrollhöhe,
      // wird beim tatsächlichen Rendern je Seite auf den echten Wert korrigiert).
      const firstPage = await pdf.getPage(1);
      if (state.destroyed) return;
      const firstUnit = firstPage.getViewport({ scale: 1 });
      const defaultRatio = firstUnit.width / firstUnit.height;

      const wrappers = new Map();
      const rendered = new Map();
      const inFlight = new Set();
      const failed = new Set();
      const visible = new Set();
      const order = [];

      content.replaceChildren();
      for (let n = 1; n <= pdf.numPages; n += 1) {
        const wrap = document.createElement('div');
        wrap.className = 'document-viewer__pdf-page';
        wrap.dataset.page = String(n);
        wrap.style.aspectRatio = String(defaultRatio);
        // Rein grafisch (kein Textlayer) -> aria-hidden; die vorlesbare Alternative liegt im
        // sr-only-Hinweis + Meta-Leiste. Der sichtbare Seitenindikator übernimmt "n von total".
        wrap.setAttribute('aria-hidden', 'true');
        wrappers.set(n, wrap);
        content.appendChild(wrap);
      }

      const updateIndicator = () => {
        if (!indicatorEl || !visible.size) return;
        indicatorEl.textContent = t('documents.viewerPdfPageLabel', {
          n: Math.min(...visible), total: pdf.numPages,
        });
      };

      const renderPage = async (n) => {
        if (state.destroyed || rendered.has(n) || inFlight.has(n) || failed.has(n)) return;
        inFlight.add(n);
        try {
          const page = await pdf.getPage(n);
          if (state.destroyed) return;
          const unit = page.getViewport({ scale: 1 });
          const viewport = page.getViewport({ scale: (renderWidth / unit.width) * dpr });
          const canvas = document.createElement('canvas');
          canvas.className = 'document-viewer__pdf-canvas';
          canvas.width = Math.floor(viewport.width);
          canvas.height = Math.floor(viewport.height);
          const ctx = canvas.getContext('2d');
          await page.render({ canvasContext: ctx, viewport }).promise;
          if (state.destroyed) return;
          const wrap = wrappers.get(n);
          if (!wrap) return;
          wrap.style.aspectRatio = String(unit.width / unit.height);
          wrap.replaceChildren(canvas);
          rendered.set(n, canvas);
          order.push(n);
          // LRU: entfernte Seiten auf Platzhalter zurücksetzen, Speicher freigeben.
          while (order.length > PDF_MAX_RENDERED) {
            const old = order.shift();
            if (old === n || !rendered.has(old)) continue;
            const oldWrap = wrappers.get(old);
            if (oldWrap) oldWrap.replaceChildren();
            rendered.delete(old);
          }
        } catch (e) {
          // Eine einzelne fehlerhafte Seite: Inline-Fehlerzustand statt endlosem Shimmer,
          // als fehlgeschlagen markieren (kein Retry-Loop beim Wieder-in-den-Blick-Scrollen).
          if (state.destroyed) return;
          failed.add(n);
          const wrap = wrappers.get(n);
          if (wrap) {
            wrap.style.aspectRatio = '';
            wrap.replaceChildren();
            wrap.insertAdjacentHTML('beforeend',
              `<div class="document-viewer__pdf-page-error">`
              + `<i data-lucide="alert-triangle" aria-hidden="true"></i>`
              + `<span>${t('documents.viewerPdfPageError')}</span></div>`);
            if (window.lucide) window.lucide.createIcons({ el: wrap });
          }
        } finally {
          inFlight.delete(n);
        }
      };

      state.observer = new IntersectionObserver((entries) => {
        for (const entry of entries) {
          const n = Number(entry.target.dataset.page);
          if (entry.isIntersecting) { visible.add(n); renderPage(n); } else { visible.delete(n); }
        }
        updateIndicator();
      }, { root: scrollRoot || null, rootMargin: '300px 0px' });
      wrappers.forEach((wrap) => state.observer.observe(wrap));
      renderPage(1);

      // Sichtbaren Seitenindikator freischalten + Ladeende für Screenreader ankündigen.
      if (indicatorEl) {
        indicatorEl.hidden = false;
        indicatorEl.textContent = t('documents.viewerPdfPageLabel', { n: 1, total: pdf.numPages });
      }
      if (liveEl) liveEl.textContent = t('documents.viewerPdfReady', { total: pdf.numPages });

      // Rotation/Größenänderung: bei relevanter Breitenänderung sichtbare Seiten neu rendern.
      state.resizeObs = new ResizeObserver(() => {
        if (state.resizeTimer) clearTimeout(state.resizeTimer);
        state.resizeTimer = setTimeout(() => {
          if (state.destroyed) return;
          const width = Math.max(240, container.clientWidth || 600);
          if (Math.abs(width - renderWidth) < 40) return;
          renderWidth = width;
          order.length = 0;
          rendered.forEach((canvas, n) => { const wrap = wrappers.get(n); if (wrap) wrap.replaceChildren(); });
          rendered.clear();
          const bounds = (scrollRoot || container).getBoundingClientRect();
          wrappers.forEach((wrap, n) => {
            const r = wrap.getBoundingClientRect();
            if (r.bottom > bounds.top - 300 && r.top < bounds.bottom + 300) renderPage(n);
          });
        }, 150);
      });
      state.resizeObs.observe(container);
    } catch (err) {
      showFallback();
    }
  })();

  return teardown;
}
