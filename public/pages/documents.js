/**
 * Module: Family Documents
 * Purpose: Grid/list document management with local uploads and member visibility.
 * Dependencies: /api.js, shared modal, i18n
 */

import { api } from '/api.js';
import { openModal as openSharedModal, closeModal, selectModal, advancedSection, promptModal, confirmModal } from '/components/modal.js';
import { t, formatDate } from '/i18n.js';
import { esc } from '/utils/html.js';
import { stagger } from '/utils/ux.js';
import { renderSkeletonList } from '/utils/skeleton.js';
import { renderPageSearch, wirePageSearch } from '/utils/page-search.js';

const CATEGORIES = ['medical', 'school', 'identity', 'insurance', 'finance', 'home', 'vehicle', 'legal', 'travel', 'pets', 'warranty', 'taxes', 'work', 'other'];
const MAX_FILE_SIZE = 5 * 1024 * 1024;

// MIME-Typen, die der Browser direkt anzeigen kann
const VIEWABLE_MIME = new Set([
  'application/pdf',
  'image/png',
  'image/jpeg',
  'image/webp',
  'text/plain',
  'text/csv',
]);

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

// Aktiven Zustand einer Chip-Gruppe umschalten (aria-pressed + Modifier).
function setActiveChip(active, groupSelector) {
  _container.querySelectorAll(`${groupSelector} .documents-filter-chip`).forEach((chip) => {
    const on = chip === active;
    chip.classList.toggle('documents-filter-chip--active', on);
    chip.setAttribute('aria-pressed', String(on));
  });
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

let state = {
  allDocuments: [],
  documents: [],
  folders: [],
  members: [],
  dmsAccounts: [],
  activeUploadBackend: 'local',
  view: localStorage.getItem('yuvomi-documents-view') || 'grid',
  status: 'active',
  category: '',
  folderId: '',
  query: '',
};
let _container = null;

export async function render(container) {
  _container = container;
  container.replaceChildren();
  container.insertAdjacentHTML('beforeend', `
    <div class="documents-page">
      <div class="page-toolbar page-toolbar--wrap documents-toolbar">
        <h1 class="page-toolbar__title">${t('documents.title')}</h1>
        ${renderPageSearch({ id: 'documents-search', label: t('documents.searchPlaceholder'), placeholder: t('documents.searchPlaceholder'), value: state.query, clearLabel: t('common.searchClear'), className: 'documents-toolbar__search page-toolbar__center' })}
        <div class="page-toolbar__actions">
          <div class="documents-view-toggle" role="group" aria-label="${t('documents.viewToggle')}">
            <button class="documents-view-toggle__btn ${state.view === 'grid' ? 'documents-view-toggle__btn--active' : ''}" data-view="grid" aria-label="${t('documents.gridView')}" aria-pressed="${state.view === 'grid'}">
              <i data-lucide="layout-grid" aria-hidden="true"></i>
            </button>
            <button class="documents-view-toggle__btn ${state.view === 'list' ? 'documents-view-toggle__btn--active' : ''}" data-view="list" aria-label="${t('documents.listView')}" aria-pressed="${state.view === 'list'}">
              <i data-lucide="list" aria-hidden="true"></i>
            </button>
          </div>
        </div>
      </div>
      <div class="documents-filters">
        <div class="documents-filter-group" id="documents-status" role="group" aria-label="${t('documents.statusLabel')}">
          <button type="button" class="documents-filter-chip${state.status === 'active' ? ' documents-filter-chip--active' : ''}" data-status="active" aria-pressed="${state.status === 'active'}">${t('documents.statusActive')}</button>
          <button type="button" class="documents-filter-chip${state.status === 'archived' ? ' documents-filter-chip--active' : ''}" data-status="archived" aria-pressed="${state.status === 'archived'}">${t('documents.statusArchived')}</button>
        </div>
        <div class="documents-filter-chips" id="documents-category" role="group" aria-label="${t('documents.categoryLabel')}">
          <button type="button" class="documents-filter-chip${!state.category ? ' documents-filter-chip--active' : ''}" data-category="" aria-pressed="${!state.category}">${t('documents.allCategories')}</button>
          ${CATEGORIES.map((category) => `<button type="button" class="documents-filter-chip${state.category === category ? ' documents-filter-chip--active' : ''}" data-category="${esc(category)}" aria-pressed="${state.category === category}"><i data-lucide="${CATEGORY_ICONS[category] || 'folder'}" class="icon-md" aria-hidden="true"></i>${esc(categoryLabels()[category])}</button>`).join('')}
        </div>
      </div>
      <div class="documents-browser-layout">
        <aside class="documents-folder-browser" aria-label="${t('documents.folderBrowserTitle')}">
          <div class="documents-folder-browser__head">
            <span class="documents-folder-browser__title">${t('documents.folderBrowserTitle')}</span>
            <button class="documents-folder-browser__add" id="documents-folder-add" type="button" aria-label="${t('documents.addFolderButton')}" title="${t('documents.addFolderButton')}">
              <i data-lucide="folder-plus" aria-hidden="true"></i>
            </button>
          </div>
          <div class="documents-folder-browser__list" id="documents-folder-browser"></div>
        </aside>
        <div id="documents-list" class="documents-list documents-list--${state.view}" aria-busy="true">${renderSkeletonList({ rows: 6, lines: 2 })}</div>
      </div>
      <button class="page-fab" id="fab-new-document" aria-label="${t('documents.addButton')}">
        <i data-lucide="upload" class="icon-xl" aria-hidden="true"></i>
      </button>
    </div>
  `);

  if (window.lucide) lucide.createIcons({ el: _container });

  await Promise.all([loadMembers(), loadFolders(), loadMetaOptions()]);
  await loadDocuments();
  renderDmsHeaderBtn();
  bindPageEvents();
  renderFolderBrowser();
  renderDocuments();
}

async function loadMembers() {
  const res = await api.get('/family/members');
  state.members = res.data || [];
}

async function loadDocuments() {
  const params = new URLSearchParams();
  params.set('status', state.status);
  if (state.category) params.set('category', state.category);
  const res = await api.get(`/documents?${params.toString()}`);
  state.allDocuments = res.data || [];
  syncFolderDocuments();
}

async function loadFolders() {
  const res = await api.get('/documents/folders');
  state.folders = res.data || [];
}

async function loadMetaOptions() {
  try {
    const res = await api.get('/documents/meta/options');
    state.dmsAccounts = res.data?.dms_accounts || [];
    state.activeUploadBackend = res.data?.active_upload_backend || 'local';
  } catch {
    state.dmsAccounts = [];
    state.activeUploadBackend = 'local';
  }
}

function renderDmsHeaderBtn() {
  const toolbar = _container.querySelector('.documents-toolbar');
  if (!toolbar) return;
  const existing = toolbar.querySelector('#documents-dms-link-btn');
  if (existing) existing.remove();
  if (!state.dmsAccounts.length) return;
  const btn = document.createElement('button');
  btn.className = 'btn btn--secondary';
  btn.id = 'documents-dms-link-btn';
  const icon = document.createElement('i');
  icon.dataset.lucide = 'link';
  icon.className = 'icon-md';
  icon.setAttribute('aria-hidden', 'true');
  btn.append(icon);
  btn.append(document.createTextNode(t('documents.linkFromDms')));
  btn.addEventListener('click', () => openDmsLinkModal());
  // In den Aktions-Slot des Kopfes hängen (vor die Ansicht-Umschaltung), damit die
  // Toolbar-Reihenfolge stimmt und der Button rechtsbündig neben der Ansicht steht.
  const actions = toolbar.querySelector('.page-toolbar__actions');
  if (actions) actions.insertAdjacentElement('afterbegin', btn);
  else toolbar.append(btn);
  if (window.lucide) lucide.createIcons({ el: btn });
}

function syncFolderDocuments() {
  if (state.folderId === '__none') {
    state.documents = state.allDocuments.filter((doc) => !doc.folder_id);
    return;
  }
  state.documents = state.folderId
    ? state.allDocuments.filter((doc) => String(doc.folder_id || '') === String(state.folderId))
    : state.allDocuments;
}

function bindPageEvents() {
  _container.querySelector('#documents-folder-add')?.addEventListener('click', () => openFolderModal());
  _container.querySelector('#fab-new-document')?.addEventListener('click', () => openDocumentModal());

  wirePageSearch(_container, {
    id: 'documents-search',
    onQuery: (value) => {
      state.query = value.trim().toLowerCase();
      renderDocuments();
    },
  });
  _container.querySelector('#documents-status')?.addEventListener('click', async (e) => {
    const chip = e.target.closest('[data-status]');
    if (!chip || chip.dataset.status === state.status) return;
    state.status = chip.dataset.status;
    setActiveChip(chip, '#documents-status');
    showDocumentsLoading();
    await loadDocuments();
    renderFolderBrowser();
    renderDocuments();
  });
  _container.querySelector('#documents-category')?.addEventListener('click', async (e) => {
    const chip = e.target.closest('[data-category]');
    if (!chip) return;
    const next = chip.dataset.category;
    if (next === state.category) return;
    state.category = next;
    setActiveChip(chip, '#documents-category');
    showDocumentsLoading();
    await loadDocuments();
    renderFolderBrowser();
    renderDocuments();
  });
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
  const folderBrowser = _container.querySelector('#documents-folder-browser');
  // Horizontale Chip-Leiste (≤1023px): Rand-Fade signalisiert weitere Ordner.
  folderBrowser?.addEventListener('scroll', () => updateFolderScrollHint(folderBrowser), { passive: true });
  folderBrowser?.addEventListener('click', (e) => {
    const menuBtn = e.target.closest('[data-folder-menu]');
    if (menuBtn) {
      const folder = state.folders.find((f) => String(f.id) === menuBtn.dataset.folderMenu);
      if (folder) openFolderMenu(folder, menuBtn);
      return;
    }
    const btn = e.target.closest('[data-folder-select]');
    if (!btn) return;
    state.folderId = btn.dataset.folderSelect;
    syncFolderDocuments();
    renderFolderBrowser();
    renderDocuments();
  });
}

function filteredDocuments() {
  if (!state.query) return state.documents;
  return state.documents.filter((doc) =>
    doc.name.toLowerCase().includes(state.query) ||
    (doc.description || '').toLowerCase().includes(state.query) ||
    doc.original_name.toLowerCase().includes(state.query)
  );
}

// Ladezustand beim Netzwerk-gebundenen Filterwechsel (Status/Kategorie):
// dieselbe Skeleton-Sprache wie beim Erstaufbau, statt die veraltete Liste
// stumm stehen zu lassen. `aria-busy` schaltet die Grid/Flex-Ansicht via CSS
// auf full-width-Block. renderDocuments() räumt beides wieder ab.
function showDocumentsLoading() {
  const list = _container?.querySelector('#documents-list');
  if (!list) return;
  list.className = `documents-list documents-list--${state.view}`;
  list.setAttribute('aria-busy', 'true');
  list.replaceChildren();
  list.insertAdjacentHTML('beforeend', renderSkeletonList({ rows: 6, lines: 2 }));
}

function renderDocuments() {
  const list = _container.querySelector('#documents-list');
  if (!list) return;
  list.removeAttribute('aria-busy');
  const docs = filteredDocuments();
  list.className = `documents-list documents-list--${state.view}`;
  if (!docs.length) {
    list.replaceChildren();
    list.insertAdjacentHTML('beforeend', `
      <div class="empty-state documents-empty-state">
        <i data-lucide="folder-open" class="empty-state__icon" aria-hidden="true"></i>
        <div class="empty-state__title">${t('documents.emptyTitle')}</div>
        <div class="empty-state__description">${t('documents.emptyDescription')}</div>
        <div class="documents-empty-state__actions">
          <button class="btn btn--primary" type="button" id="documents-empty-upload">
            <i data-lucide="upload" class="icon-md" aria-hidden="true"></i>
            ${t('documents.emptyPrimary')}
          </button>
          <button class="btn btn--secondary" type="button" id="documents-empty-folder">
            <i data-lucide="folder-plus" class="icon-md" aria-hidden="true"></i>
            ${t('documents.emptySecondary')}
          </button>
        </div>
      </div>
    `);
    if (window.lucide) lucide.createIcons({ el: list });
    list.querySelector('#documents-empty-upload')?.addEventListener('click', () => openDocumentModal());
    list.querySelector('#documents-empty-folder')?.addEventListener('click', () => openFolderModal());
    return;
  }
  list.replaceChildren();
  list.insertAdjacentHTML('beforeend', docs.map((doc) => state.view === 'list' ? renderListItem(doc) : renderGridCard(doc)).join(''));
  if (window.lucide) lucide.createIcons({ el: list });
  stagger(list.querySelectorAll('.document-card, .document-row'));
}

function folderCounts() {
  const counts = new Map();
  counts.set('', state.allDocuments.length);
  counts.set('__none', state.allDocuments.filter((doc) => !doc.folder_id).length);
  state.folders.forEach((folder) => counts.set(String(folder.id), 0));
  state.allDocuments.forEach((doc) => {
    if (!doc.folder_id) return;
    const key = String(doc.folder_id);
    counts.set(key, (counts.get(key) || 0) + 1);
  });
  return counts;
}

function renderFolderBrowser() {
  const browser = _container.querySelector('#documents-folder-browser');
  if (!browser) return;
  const counts = folderCounts();
  const items = [
    { id: '', name: t('documents.allFolders'), icon: 'folders', managed: false },
    { id: '__none', name: t('documents.noFolder'), icon: 'folder-x', managed: false },
    ...state.folders.map((folder) => ({ id: String(folder.id), name: folder.name, icon: 'folder', managed: true })),
  ];
  browser.replaceChildren();
  browser.insertAdjacentHTML('beforeend', items.map((item) => {
    const active = String(state.folderId) === item.id;
    return `
    <div class="documents-folder-item ${active ? 'documents-folder-item--active' : ''} ${item.managed ? 'documents-folder-item--managed' : ''}">
      <button class="documents-folder-item__select" type="button" data-folder-select="${esc(item.id)}" aria-current="${active ? 'true' : 'false'}">
        <span class="documents-folder-item__icon"><i data-lucide="${esc(item.icon)}" aria-hidden="true"></i></span>
        <span class="documents-folder-item__name">${esc(item.name)}</span>
        <span class="documents-folder-item__count">${counts.get(item.id) || 0}</span>
      </button>
      ${item.managed ? `
      <button class="documents-folder-item__menu" type="button" data-folder-menu="${esc(item.id)}" aria-label="${t('documents.folderActions')}" title="${t('documents.folderActions')}">
        <i data-lucide="more-vertical" aria-hidden="true"></i>
      </button>` : ''}
    </div>`;
  }).join(''));
  if (window.lucide) lucide.createIcons({ el: browser });
  updateFolderScrollHint(browser);
}

// Rand-Fade der horizontalen Ordner-Leiste (Mobile/Tablet): nur zeigen, wenn
// tatsächlich überlaufend, und am rechten Ende ausblenden — ehrliche Affordanz
// „hier gibt es mehr Ordner", statt einer ständig abgeschnittenen letzten Kachel.
function updateFolderScrollHint(browser) {
  if (!browser) return;
  const scrollable = browser.scrollWidth - browser.clientWidth > 1;
  const atEnd = browser.scrollLeft + browser.clientWidth >= browser.scrollWidth - 1;
  browser.classList.toggle('documents-folder-browser__list--scrollable', scrollable);
  browser.classList.toggle('documents-folder-browser__list--at-end', atEnd);
}

// --------------------------------------------------------
// Kontext-Popover (Ordner- & Dokument-Aktionen)
// Body-Level + position:fixed → entkommt overflow-Clipping der Chip-Leiste/Sidebar.
// --------------------------------------------------------

let _contextMenu = null;

function closeContextMenu() {
  if (!_contextMenu) return;
  const { el, anchorBtn, onDoc, onKey } = _contextMenu;
  document.removeEventListener('click', onDoc, true);
  document.removeEventListener('keydown', onKey, true);
  window.removeEventListener('resize', closeContextMenu, true);
  window.removeEventListener('scroll', closeContextMenu, true);
  el.remove();
  anchorBtn?.setAttribute('aria-expanded', 'false');
  _contextMenu = null;
}

// Geteiltes Body-Level-Popover für Ordner- und Dokument-Aktionen.
// `itemsHtml` liefert die <button role="menuitem" data-menu-action="…">-Einträge,
// `onAction(action)` wird nach dem Schließen mit dem gewählten Wert aufgerufen.
// Tastatur: Pfeil hoch/runter + Home/End wandern zwischen den Einträgen, Escape
// schließt und gibt den Fokus an den Auslöser zurück.
function openContextMenu(anchorBtn, itemsHtml, onAction) {
  closeContextMenu();
  const menu = document.createElement('div');
  menu.className = 'documents-context-menu';
  menu.setAttribute('role', 'menu');
  menu.insertAdjacentHTML('beforeend', itemsHtml);
  document.body.appendChild(menu);
  if (window.lucide) lucide.createIcons({ el: menu });

  const r = anchorBtn.getBoundingClientRect();
  const mw = menu.offsetWidth;
  const mh = menu.offsetHeight;
  let left = Math.max(8, r.right - mw);
  left = Math.min(left, window.innerWidth - mw - 8);
  let top = r.bottom + 4;
  if (top + mh > window.innerHeight - 8) top = Math.max(8, r.top - mh - 4);
  menu.style.left = `${Math.round(left)}px`;
  menu.style.top = `${Math.round(top)}px`;
  anchorBtn.setAttribute('aria-expanded', 'true');

  const onDoc = (e) => {
    if (menu.contains(e.target) || anchorBtn.contains(e.target)) return;
    closeContextMenu();
  };
  const items = () => Array.from(menu.querySelectorAll('[data-menu-action]'));
  const onKey = (e) => {
    if (e.key === 'Escape') { closeContextMenu(); anchorBtn.focus(); return; }
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
  };

  menu.addEventListener('click', (e) => {
    const item = e.target.closest('[data-menu-action]');
    if (!item) return;
    const action = item.dataset.menuAction;
    closeContextMenu();
    onAction(action);
  });

  _contextMenu = { el: menu, anchorBtn, onDoc, onKey };
  setTimeout(() => {
    document.addEventListener('click', onDoc, true);
    document.addEventListener('keydown', onKey, true);
    window.addEventListener('resize', closeContextMenu, true);
    window.addEventListener('scroll', closeContextMenu, true);
    items()[0]?.focus();
  }, 0);
}

function openFolderMenu(folder, anchorBtn) {
  openContextMenu(anchorBtn, `
    <button class="documents-context-menu__item" type="button" role="menuitem" data-menu-action="rename">
      <i data-lucide="pencil" aria-hidden="true"></i><span>${t('documents.renameFolder')}</span>
    </button>
    <button class="documents-context-menu__item documents-context-menu__item--danger" type="button" role="menuitem" data-menu-action="delete">
      <i data-lucide="trash-2" aria-hidden="true"></i><span>${t('documents.deleteFolder')}</span>
    </button>
  `, async (action) => {
    if (action === 'rename') await renameFolder(folder);
    else if (action === 'delete') await deleteFolder(folder);
  });
}

// Overflow-Menü einer Dokumentkarte/-zeile: Sekundäraktionen aus der Aktionszeile
// (bearbeiten, archivieren, an DMS senden, löschen) — hält die Zeile auf zwei
// Primäraktionen (Ansehen/Download) + Kebab begrenzt.
function openDocumentMenu(doc, anchorBtn) {
  const archived = doc.status === 'archived';
  const canPushDms = documentStorageBackend(doc) !== 'dms' && state.dmsAccounts.length > 0;
  openContextMenu(anchorBtn, `
    <button class="documents-context-menu__item" type="button" role="menuitem" data-menu-action="edit">
      <i data-lucide="pencil" aria-hidden="true"></i><span>${t('documents.editAction')}</span>
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
    await loadFolders();
    renderFolderBrowser();
  } catch (err) {
    window.yuvomi?.showToast(err.data?.error ?? t('common.unknownError'), 'danger');
  }
}

async function deleteFolder(folder) {
  const confirmed = await confirmModal(
    t('documents.deleteFolderConfirm', { name: folder.name }),
    { danger: true, confirmLabel: t('documents.deleteFolder') },
  );
  if (!confirmed) return;
  try {
    await api.delete(`/documents/folders/${folder.id}`);
    window.yuvomi?.showToast(t('documents.folderDeletedToast'), 'default');
    if (String(state.folderId) === String(folder.id)) state.folderId = '';
    await loadFolders();
    await loadDocuments();
    renderFolderBrowser();
    renderDocuments();
  } catch (err) {
    window.yuvomi?.showToast(err.data?.error ?? t('common.unknownError'), 'danger');
  }
}

function renderMeta(doc) {
  const labels = categoryLabels();
  return `
    <span><i data-lucide="${CATEGORY_ICONS[doc.category] || 'folder'}" aria-hidden="true"></i>${labels[doc.category] || doc.category}</span>
    ${doc.folder_name ? `<span><i data-lucide="folder" aria-hidden="true"></i>${esc(doc.folder_name)}</span>` : ''}
    <span><i data-lucide="${doc.visibility === 'family' ? 'users' : doc.visibility === 'private' ? 'lock' : 'user-check'}" aria-hidden="true"></i>${t(`documents.visibility.${doc.visibility}`)}</span>
    <span>${formatFileSize(doc.file_size)}</span>
    ${storageBadgeHtml(doc)}
  `;
}

function documentStorageBackend(doc) {
  if (doc.storage_backend) return doc.storage_backend;
  return doc.storage_provider === 'external' ? 'dms' : 'local';
}

function uploadBackendLabel(backend) {
  if (backend === 'webdav') return t('documents.storageWebdav');
  if (backend === 'local_folder') return t('documents.storageLocalFolder');
  return t('documents.storageLocal');
}

function uploadTargetIcon(backend) {
  if (backend === 'webdav') return 'cloud';
  if (backend === 'local_folder') return 'folder';
  return 'database';
}

function storageBadgeHtml(doc) {
  const backend = documentStorageBackend(doc);
  if (backend === 'webdav') {
    return `<span class="doc-badge doc-badge--webdav">${t('documents.storageWebdav')}</span>`;
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

function renderGridCard(doc) {
  return `
    <article class="document-card" data-id="${doc.id}">
      <div class="document-card__header">
        <div class="document-card__icon"><i data-lucide="${CATEGORY_ICONS[doc.category] || 'file'}" aria-hidden="true"></i></div>
        <span class="document-card__date">${formatDate(doc.updated_at)}</span>
      </div>
      <div class="document-card__body">
        <h2 class="document-card__title">${esc(doc.name)}</h2>
        <p class="document-card__description">${esc(doc.description || doc.original_name)}</p>
        <div class="document-card__meta">${renderMeta(doc)}</div>
      </div>
      <div class="document-card__actions">${renderActions(doc)}</div>
    </article>
  `;
}

function renderListItem(doc) {
  return `
    <article class="document-row" data-id="${doc.id}">
      <div class="document-row__icon"><i data-lucide="${CATEGORY_ICONS[doc.category] || 'file'}" aria-hidden="true"></i></div>
      <div class="document-row__body">
        <h2 class="document-row__title">${esc(doc.name)}</h2>
        <div class="document-row__meta">${renderMeta(doc)}</div>
      </div>
      <div class="document-row__actions">${renderActions(doc)}</div>
    </article>
  `;
}

function handleDocumentAction(e) {
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
  if (action === 'archive') {
    await api.patch(`/documents/${doc.id}/archive`, { archived: doc.status !== 'archived' });
    window.yuvomi?.showToast(doc.status === 'archived' ? t('documents.restoredToast') : t('documents.archivedToast'), 'success');
    await loadDocuments();
    renderFolderBrowser();
    renderDocuments();
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
  if (action === 'delete') {
    state.allDocuments = state.allDocuments.filter((d) => d.id !== doc.id);
    syncFolderDocuments();
    renderFolderBrowser();
    renderDocuments();

    let undone = false;
    window.yuvomi?.showToast(t('documents.deletedToast'), 'default', 5000, () => {
      undone = true;
      state.allDocuments = [...state.allDocuments, doc].sort((a, b) => a.name.localeCompare(b.name));
      syncFolderDocuments();
      renderFolderBrowser();
      renderDocuments();
    });

    setTimeout(async () => {
      if (undone) return;
      try {
        await api.delete(`/documents/${doc.id}`);
        await loadDocuments();
        renderFolderBrowser();
        renderDocuments();
      } catch (err) {
        state.allDocuments = [...state.allDocuments, doc].sort((a, b) => a.name.localeCompare(b.name));
        syncFolderDocuments();
        renderFolderBrowser();
        renderDocuments();
        window.yuvomi?.showToast(err.data?.error ?? t('common.unknownError'), 'danger');
      }
    }, 5000);
  }
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

function openDocumentModal(doc = null) {
  const isEdit = !!doc;

  // Kontextbezogener Upload: ist im Browser ein echter Ordner gewählt, wird er
  // im Modal vorausgewählt (weiterhin änderbar). „Alle Ordner"/„Kein Ordner"
  // (leer bzw. __none) setzen keinen Zielordner.
  const presetFolderId = (!isEdit && state.folderId && state.folderId !== '__none')
    ? String(state.folderId)
    : String(doc?.folder_id || '');

  // Sekundärfelder: Beschreibung, Sichtbarkeit/Status + Mitglieder-Freigabe.
  const advancedOpen = isEdit && (
    !!doc.description
    || (!!doc.visibility && doc.visibility !== 'family')
    || doc.status === 'archived'
  );

  const advancedFieldsHtml = `
        <div class="form-group">
          <label class="label" for="document-description">${t('documents.descriptionLabel')}</label>
          <textarea class="input" id="document-description" rows="3" maxlength="5000">${esc(doc?.description || '')}</textarea>
        </div>
        <div class="modal-grid modal-grid--2">
          <div class="form-group">
            <label class="label" for="document-visibility">${t('documents.visibilityLabel')}</label>
            <select class="input" id="document-visibility">
              <option value="family" ${doc?.visibility === 'family' ? 'selected' : ''}>${t('documents.visibility.family')}</option>
              <option value="restricted" ${doc?.visibility === 'restricted' ? 'selected' : ''}>${t('documents.visibility.restricted')}</option>
              <option value="private" ${doc?.visibility === 'private' ? 'selected' : ''}>${t('documents.visibility.private')}</option>
            </select>
          </div>
          <div class="form-group">
            <label class="label" for="document-status">${t('documents.statusLabel')}</label>
            <select class="input" id="document-status">
              <option value="active" ${doc?.status !== 'archived' ? 'selected' : ''}>${t('documents.statusActive')}</option>
              <option value="archived" ${doc?.status === 'archived' ? 'selected' : ''}>${t('documents.statusArchived')}</option>
            </select>
          </div>
        </div>
        <div class="document-member-picker" id="document-member-picker">
          <div class="label">${t('documents.allowedMembersLabel')}</div>
          <div class="document-member-picker__grid">${memberOptions(doc?.allowed_member_ids || [])}</div>
        </div>`;

  openSharedModal({
    title: isEdit ? t('documents.editTitle') : t('documents.newTitle'),
    size: 'lg',
    content: `
      <form id="document-form" class="document-form">
        <div class="modal-grid modal-grid--2">
          <div class="form-group">
            <label class="label" for="document-name">${t('documents.nameLabel')}</label>
            <input class="input" id="document-name" name="name" required maxlength="200" value="${esc(doc?.name || '')}">
          </div>
          <div class="form-group">
            <label class="label" for="document-category">${t('documents.categoryLabel')}</label>
            <select class="input" id="document-category">
              ${CATEGORIES.map((category) => `<option value="${category}" ${doc?.category === category ? 'selected' : ''}>${categoryLabels()[category]}</option>`).join('')}
            </select>
          </div>
          <div class="form-group">
            <label class="label" for="document-folder">${t('documents.folderLabel')}</label>
            <select class="input" id="document-folder">
              <option value="">${t('documents.noFolder')}</option>
              ${state.folders.map((folder) => `<option value="${folder.id}" ${presetFolderId === String(folder.id) ? 'selected' : ''}>${esc(folder.name)}</option>`).join('')}
            </select>
          </div>
        </div>
        ${!isEdit ? `
        <div class="form-group">
          <label class="label" for="document-file">${t('documents.fileLabel')}</label>
          <p class="document-storage-target">
            <i data-lucide="${uploadTargetIcon(state.activeUploadBackend)}" aria-hidden="true"></i>
            <span>${t('documents.activeUploadTarget', {
              target: uploadBackendLabel(state.activeUploadBackend),
            })}</span>
          </p>
          <label class="document-dropzone" id="document-dropzone" for="document-file">
            <input class="sr-only" id="document-file" type="file" required>
            <span class="document-dropzone__icon">
              <i data-lucide="file-up" aria-hidden="true"></i>
            </span>
            <span class="document-dropzone__title">${t('documents.dropzoneTitle')}</span>
            <span class="document-dropzone__hint">${t('documents.dropzoneHint')}</span>
            <span class="document-dropzone__file" id="document-selected-file" hidden></span>
          </label>
          <p class="document-form__hint">${t('documents.fileHint')}</p>
        </div>` : ''}
        ${advancedSection(advancedFieldsHtml, { open: advancedOpen })}
        <div id="document-error" class="login-error" hidden></div>
        <div class="modal-panel__footer" style="padding:0;border:none;margin-top:var(--space-5)">
          <button type="submit" class="btn btn--primary" id="document-submit">${isEdit ? t('common.save') : t('documents.uploadAction')}</button>
        </div>
      </form>
    `,
    onSave(panel) {
      const form = panel.querySelector('#document-form');
      const visibility = panel.querySelector('#document-visibility');
      const picker = panel.querySelector('#document-member-picker');
      const syncVisibility = () => { picker.hidden = visibility.value !== 'restricted'; };
      visibility.addEventListener('change', syncVisibility);
      syncVisibility();
      bindDropzone(panel);
      form.addEventListener('submit', (event) => saveDocument(event, doc));
    },
  });
}

function bindDropzone(panel) {
  const dropzone = panel.querySelector('#document-dropzone');
  const input = panel.querySelector('#document-file');
  const selected = panel.querySelector('#document-selected-file');
  if (!dropzone || !input || !selected) return;

  const syncSelectedFile = () => {
    const file = input.files?.[0];
    selected.hidden = !file;
    selected.textContent = file ? t('documents.selectedFileLabel', { name: file.name }) : '';
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
    const file = event.dataTransfer?.files?.[0];
    if (!file) return;
    const transfer = new DataTransfer();
    transfer.items.add(file);
    input.files = transfer.files;
    syncSelectedFile();
  });
}

async function saveDocument(event, doc) {
  event.preventDefault();
  const form = event.target;
  const error = form.querySelector('#document-error');
  const submit = form.querySelector('#document-submit');
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
    if (!doc) {
      const file = form.querySelector('#document-file').files?.[0];
      if (!file) throw new Error(t('documents.fileRequired'));
      if (file.size > MAX_FILE_SIZE) throw new Error(t('documents.fileTooLarge'));
      payload.original_name = file.name;
      payload.content_data = await readFileAsDataUrl(file);
      if (!payload.name) payload.name = file.name.replace(/\.[^.]+$/, '');
    }
    if (!payload.name) throw new Error(t('common.required'));
    if (doc) await api.put(`/documents/${doc.id}`, payload);
    else await api.post('/documents', payload);
    window.yuvomi?.showToast(doc ? t('documents.savedToast') : t('documents.uploadedToast'), 'success');
    closeModal({ force: true });
    await loadDocuments();
    renderFolderBrowser();
    renderDocuments();
  } catch (err) {
    error.textContent = friendlyError(err);
    error.hidden = false;
  } finally {
    submit.disabled = false;
  }
}

function openFolderModal() {
  openSharedModal({
    title: t('documents.newFolderTitle'),
    size: 'sm',
    content: `
      <form id="document-folder-form" class="document-form">
        <div class="form-group">
          <label class="label" for="document-folder-name">${t('documents.folderNameLabel')}</label>
          <input class="input" id="document-folder-name" required maxlength="200" autocomplete="off">
        </div>
        <div id="document-folder-error" class="login-error" hidden></div>
        <div class="modal-panel__footer" style="padding:0;border:none;margin-top:var(--space-5)">
          <button type="submit" class="btn btn--primary">${t('documents.createFolderAction')}</button>
        </div>
      </form>
    `,
    onSave(panel) {
      panel.querySelector('#document-folder-form')?.addEventListener('submit', async (event) => {
        event.preventDefault();
        const error = panel.querySelector('#document-folder-error');
        const input = panel.querySelector('#document-folder-name');
        error.hidden = true;
        try {
          const res = await api.post('/documents/folders', { name: input.value.trim() });
          window.yuvomi?.showToast(t('documents.folderCreatedToast'), 'success');
          state.folderId = String(res.data?.id || '');
          await loadFolders();
          await loadDocuments();
          closeModal({ force: true });
          syncFolderDocuments();
          renderFolderBrowser();
          renderDocuments();
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

      const input = document.createElement('input');
      input.className = 'input';
      input.id = 'dms-search';
      input.type = 'search';
      input.placeholder = t('documents.dmsSearchPlaceholder');

      const results = document.createElement('ul');
      results.id = 'dms-results';
      results.className = 'dms-results';

      root.append(input, hint, results);
      syncHint();

      const runDmsSearch = async (q) => {
        results.replaceChildren();
        try {
          const res = await api.get(`/documents/dms/search?account_id=${selectedAccountId}&q=${encodeURIComponent(q)}`);
          renderDmsResults(results, res.data, selectedAccountId);
        } catch {
          const li = document.createElement('li');
          li.className = 'form-hint';
          li.textContent = t('documents.dmsNoResults');
          results.appendChild(li);
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
  for (const item of items) {
    const li = document.createElement('li');
    li.className = 'dms-result';

    const label = document.createElement('span');
    label.className = 'dms-result__title';
    label.textContent = item.title;

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn btn--primary btn--sm';
    btn.textContent = t('documents.dmsLinkBtn');

    btn.addEventListener('click', async () => {
      btn.disabled = true;
      try {
        await api.post('/documents/dms/link', {
          account_id: accountId,
          dms_document_id: item.id,
          category: state.category || 'other',
          visibility: 'family',
        });
        closeModal({ force: true });
        await loadDocuments();
        renderFolderBrowser();
        renderDocuments();
      } catch (err) {
        btn.disabled = false;
        window.yuvomi?.showToast(err.data?.error ?? t('common.unknownError'), 'danger');
      }
    });

    li.append(label, btn);
    container.appendChild(li);
  }
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
            ${doc.mime_type === 'application/pdf' ? `
            <a class="btn btn--ghost btn--icon btn--icon-sm" href="${previewUrl}" target="_blank" rel="noopener noreferrer"
               title="${t('documents.viewerOpenInTab')}" aria-label="${t('documents.viewerOpenInTab')}">
              <i data-lucide="external-link" class="icon-md" aria-hidden="true"></i>
            </a>` : ''}
            <a class="btn btn--primary btn--icon btn--icon-sm" href="${downloadUrl}" download
               title="${t('documents.downloadAction')}" aria-label="${t('documents.downloadAction')}">
              <i data-lucide="download" class="icon-md" aria-hidden="true"></i>
            </a>
          </span>
        </div>
        <div class="document-viewer__body" id="document-viewer-body">
          ${renderViewerContent(doc, previewUrl, downloadUrl)}
        </div>
      </div>
    `,
    onClose() {
      if (typeof pdfTeardown === 'function') pdfTeardown();
    },
    onSave(panel) {
      if (window.lucide) window.lucide.createIcons({ el: panel });
      // PDFs ohne nativen Inline-Viewer (mobile Browser): mit pdf.js auf Canvas rendern
      if (doc.mime_type === 'application/pdf' && !canRenderPdfNatively()) {
        const container = panel.querySelector('[data-pdf-pages]');
        pdfTeardown = renderPdfPages(container, previewUrl, doc, downloadUrl);
      }
      // Text-Dokumente: Inhalt asynchron laden
      if (doc.mime_type === 'text/plain' || doc.mime_type === 'text/csv') {
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
}

function renderViewerContent(doc, previewUrl, downloadUrl) {
  if (doc.mime_type === 'application/pdf') {
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
  if (doc.mime_type === 'image/png' || doc.mime_type === 'image/jpeg' || doc.mime_type === 'image/webp') {
    return `<img class="document-viewer__image" src="${previewUrl}" alt="${esc(doc.name)}"`
      + ` loading="lazy">`;
  }
  if (doc.mime_type === 'text/plain' || doc.mime_type === 'text/csv') {
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
