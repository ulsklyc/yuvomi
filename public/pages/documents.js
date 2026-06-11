/**
 * Module: Family Documents
 * Purpose: Grid/list document management with local uploads and member visibility.
 * Dependencies: /api.js, shared modal, i18n
 */

import { api } from '/api.js';
import { openModal as openSharedModal, closeModal, selectModal } from '/components/modal.js';
import { t, formatDate } from '/i18n.js';
import { esc } from '/utils/html.js';
import { stagger } from '/utils/ux.js';

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

let state = {
  allDocuments: [],
  documents: [],
  folders: [],
  members: [],
  dmsAccounts: [],
  activeUploadBackend: 'local',
  view: localStorage.getItem('oikos-documents-view') || 'grid',
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
      <div class="page-toolbar documents-toolbar">
        <h1 class="page-toolbar__title">${t('documents.title')}</h1>
        <div class="documents-toolbar__search">
          <i data-lucide="search" class="documents-toolbar__search-icon" aria-hidden="true"></i>
          <input class="documents-toolbar__search-input" id="documents-search" type="search" placeholder="${t('documents.searchPlaceholder')}" autocomplete="off">
        </div>
        <div class="documents-view-toggle" role="group" aria-label="${t('documents.viewToggle')}">
          <button class="documents-view-toggle__btn ${state.view === 'grid' ? 'documents-view-toggle__btn--active' : ''}" data-view="grid" aria-label="${t('documents.gridView')}">
            <i data-lucide="layout-grid" aria-hidden="true"></i>
          </button>
          <button class="documents-view-toggle__btn ${state.view === 'list' ? 'documents-view-toggle__btn--active' : ''}" data-view="list" aria-label="${t('documents.listView')}">
            <i data-lucide="list" aria-hidden="true"></i>
          </button>
        </div>
        <button class="btn btn--primary" id="documents-add-btn">
          <i data-lucide="upload" class="icon-md" aria-hidden="true"></i>
          ${t('documents.addButton')}
        </button>
        <button class="btn btn--secondary" id="documents-folder-btn">
          <i data-lucide="folder-plus" class="icon-md" aria-hidden="true"></i>
          ${t('documents.addFolderButton')}
        </button>
      </div>
      <div class="documents-filters">
        <select class="input documents-filter-select" id="documents-status">
          <option value="active">${t('documents.statusActive')}</option>
          <option value="archived">${t('documents.statusArchived')}</option>
        </select>
        <select class="input documents-filter-select" id="documents-category">
          <option value="">${t('documents.allCategories')}</option>
          ${CATEGORIES.map((category) => `<option value="${category}">${categoryLabels()[category]}</option>`).join('')}
        </select>
        <select class="input documents-filter-select" id="documents-folder">
          <option value="">${t('documents.allFolders')}</option>
          <option value="__none">${t('documents.noFolder')}</option>
        </select>
      </div>
      <div class="documents-browser-layout">
        <aside class="documents-folder-browser" aria-label="${t('documents.folderBrowserTitle')}">
          <div class="documents-folder-browser__title">${t('documents.folderBrowserTitle')}</div>
          <div class="documents-folder-browser__list" id="documents-folder-browser"></div>
        </aside>
        <div id="documents-list" class="documents-list documents-list--${state.view}"></div>
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
  renderFolderOptions();
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
  // Insert after the folder button
  const folderBtn = toolbar.querySelector('#documents-folder-btn');
  if (folderBtn) {
    folderBtn.insertAdjacentElement('afterend', btn);
  } else {
    toolbar.append(btn);
  }
  if (window.lucide) lucide.createIcons({ el: btn });
}

function renderFolderOptions() {
  const select = _container.querySelector('#documents-folder');
  if (!select) return;
  select.replaceChildren();
  select.insertAdjacentHTML('beforeend', `<option value="">${t('documents.allFolders')}</option>`);
  select.insertAdjacentHTML('beforeend', `<option value="__none" ${state.folderId === '__none' ? 'selected' : ''}>${t('documents.noFolder')}</option>`);
  state.folders.forEach((folder) => {
    select.insertAdjacentHTML('beforeend', `<option value="${folder.id}" ${String(folder.id) === String(state.folderId) ? 'selected' : ''}>${esc(folder.name)}</option>`);
  });
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
  _container.querySelector('#documents-add-btn')?.addEventListener('click', () => openDocumentModal());
  _container.querySelector('#documents-folder-btn')?.addEventListener('click', () => openFolderModal());
  _container.querySelector('#fab-new-document')?.addEventListener('click', () => openDocumentModal());
  let documentsSearchTimer;
  _container.querySelector('#documents-search')?.addEventListener('input', (e) => {
    const value = e.target.value.trim().toLowerCase();
    clearTimeout(documentsSearchTimer);
    documentsSearchTimer = setTimeout(() => {
      state.query = value;
      renderDocuments();
    }, 200);
  });
  _container.querySelector('#documents-status')?.addEventListener('change', async (e) => {
    state.status = e.target.value;
    await loadDocuments();
    renderFolderBrowser();
    renderDocuments();
  });
  _container.querySelector('#documents-category')?.addEventListener('change', async (e) => {
    state.category = e.target.value;
    await loadDocuments();
    renderFolderBrowser();
    renderDocuments();
  });
  _container.querySelector('#documents-folder')?.addEventListener('change', async (e) => {
    state.folderId = e.target.value;
    syncFolderDocuments();
    renderFolderBrowser();
    renderDocuments();
  });
  _container.querySelector('.documents-view-toggle')?.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-view]');
    if (!btn) return;
    state.view = btn.dataset.view;
    localStorage.setItem('oikos-documents-view', state.view);
    _container.querySelectorAll('.documents-view-toggle__btn').forEach((el) =>
      el.classList.toggle('documents-view-toggle__btn--active', el === btn)
    );
    renderDocuments();
  });
  _container.querySelector('#documents-list')?.addEventListener('click', handleDocumentAction);
  _container.querySelector('#documents-folder-browser')?.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-folder-id]');
    if (!btn) return;
    state.folderId = btn.dataset.folderId;
    syncFolderDocuments();
    renderFolderOptions();
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

function renderDocuments() {
  const list = _container.querySelector('#documents-list');
  if (!list) return;
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
    { id: '', name: t('documents.allFolders'), icon: 'folders' },
    { id: '__none', name: t('documents.noFolder'), icon: 'folder-x' },
    ...state.folders.map((folder) => ({ id: String(folder.id), name: folder.name, icon: 'folder' })),
  ];
  browser.replaceChildren();
  browser.insertAdjacentHTML('beforeend', items.map((item) => `
    <button class="documents-folder-item ${String(state.folderId) === item.id ? 'documents-folder-item--active' : ''}" type="button" data-folder-id="${esc(item.id)}" aria-current="${String(state.folderId) === item.id ? 'true' : 'false'}">
      <span class="documents-folder-item__icon"><i data-lucide="${esc(item.icon)}" aria-hidden="true"></i></span>
      <span class="documents-folder-item__name">${esc(item.name)}</span>
      <span class="documents-folder-item__count">${counts.get(item.id) || 0}</span>
    </button>
  `).join(''));
  if (window.lucide) lucide.createIcons({ el: browser });
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
  return `<span class="doc-badge doc-badge--local">${t('documents.storageLocal')}</span>`;
}

function renderActions(doc) {
  const canView = VIEWABLE_MIME.has(doc.mime_type);
  const storageBackend = documentStorageBackend(doc);
  return `
    ${canView ? `
    <button class="btn btn--ghost btn--icon btn--icon-sm" data-action="view" data-id="${doc.id}" title="${t('documents.viewAction')}" aria-label="${t('documents.viewAction')}">
      <i data-lucide="eye" class="icon-md" aria-hidden="true"></i>
    </button>` : ''}
    <a class="btn btn--ghost btn--icon btn--icon-sm" href="/api/v1/documents/${doc.id}/download" download title="${t('documents.downloadAction')}" aria-label="${t('documents.downloadAction')}">
      <i data-lucide="download" class="icon-md" aria-hidden="true"></i>
    </a>
    <button class="btn btn--ghost btn--icon btn--icon-sm" data-action="edit" data-id="${doc.id}" title="${t('documents.editAction')}" aria-label="${t('documents.editAction')}">
      <i data-lucide="settings" class="icon-md" aria-hidden="true"></i>
    </button>
    <button class="btn btn--ghost btn--icon btn--icon-sm" data-action="archive" data-id="${doc.id}" data-archived="${doc.status === 'archived'}" title="${doc.status === 'archived' ? t('documents.restoreAction') : t('documents.archiveAction')}" aria-label="${doc.status === 'archived' ? t('documents.restoreAction') : t('documents.archiveAction')}">
      <i data-lucide="${doc.status === 'archived' ? 'archive-restore' : 'archive'}" class="icon-md" aria-hidden="true"></i>
    </button>
    ${storageBackend !== 'dms' && state.dmsAccounts.length > 0 ? `
    <button class="btn btn--ghost btn--icon btn--icon-sm" data-action="push-dms" data-id="${doc.id}" title="${t('documents.pushToDms')}" aria-label="${t('documents.pushToDms')}">
      <i data-lucide="upload" class="icon-md" aria-hidden="true"></i>
    </button>` : ''}
    <button class="btn btn--ghost btn--icon btn--icon-sm documents-danger" data-action="delete" data-id="${doc.id}" title="${t('common.delete')}" aria-label="${t('common.delete')}">
      <i data-lucide="trash-2" class="icon-md" aria-hidden="true"></i>
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

async function handleDocumentAction(e) {
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
  if (!doc) return;
  if (btn.dataset.action === 'view') openDocumentViewer(doc);
  if (btn.dataset.action === 'edit') openDocumentModal(doc);
  if (btn.dataset.action === 'archive') {
    await api.patch(`/documents/${doc.id}/archive`, { archived: doc.status !== 'archived' });
    window.oikos?.showToast(doc.status === 'archived' ? t('documents.restoredToast') : t('documents.archivedToast'), 'success');
    await loadDocuments();
    renderFolderBrowser();
    renderDocuments();
  }
  if (btn.dataset.action === 'push-dms') {
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
      window.oikos?.showToast(t('documents.pushToDmsQueued'), 'success');
    } catch (err) {
      window.oikos?.showToast(err.data?.error ?? t('common.unknownError'), 'danger');
    }
    return;
  }
  if (btn.dataset.action === 'delete') {
    state.allDocuments = state.allDocuments.filter((d) => d.id !== doc.id);
    syncFolderDocuments();
    renderFolderBrowser();
    renderDocuments();

    let undone = false;
    window.oikos?.showToast(t('documents.deletedToast'), 'default', 5000, () => {
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
        window.oikos?.showToast(err.data?.error ?? t('common.unknownError'), 'danger');
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
              ${state.folders.map((folder) => `<option value="${folder.id}" ${String(doc?.folder_id || '') === String(folder.id) ? 'selected' : ''}>${esc(folder.name)}</option>`).join('')}
            </select>
          </div>
        </div>
        <div class="form-group">
          <label class="label" for="document-description">${t('documents.descriptionLabel')}</label>
          <textarea class="input" id="document-description" rows="3" maxlength="5000">${esc(doc?.description || '')}</textarea>
        </div>
        ${!isEdit ? `
        <div class="form-group">
          <label class="label" for="document-file">${t('documents.fileLabel')}</label>
          <p class="document-storage-target">
            <i data-lucide="${state.activeUploadBackend === 'webdav' ? 'cloud' : 'database'}" aria-hidden="true"></i>
            <span>${t('documents.activeUploadTarget', {
              target: state.activeUploadBackend === 'webdav'
                ? t('documents.storageWebdav')
                : t('documents.storageLocal'),
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
        </div>
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
    window.oikos?.showToast(doc ? t('documents.savedToast') : t('documents.uploadedToast'), 'success');
    closeModal({ force: true });
    await loadDocuments();
    renderFolderBrowser();
    renderDocuments();
  } catch (err) {
    error.textContent = err.message;
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
          window.oikos?.showToast(t('documents.folderCreatedToast'), 'success');
          state.folderId = String(res.data?.id || '');
          await loadFolders();
          await loadDocuments();
          closeModal({ force: true });
          renderFolderOptions();
          renderFolderBrowser();
          renderDocuments();
        } catch (err) {
          error.textContent = err.message;
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
          // Clear results and re-run search with new account
          results.replaceChildren();
          if (input.value.trim()) {
            input.dispatchEvent(new Event('input'));
          }
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

      root.append(input, results);

      let dmsSearchTimer;
      input.addEventListener('input', () => {
        clearTimeout(dmsSearchTimer);
        dmsSearchTimer = setTimeout(async () => {
          const q = input.value.trim();
          results.replaceChildren();
          if (!q) return;
          try {
            const res = await api.get(`/documents/dms/search?account_id=${selectedAccountId}&q=${encodeURIComponent(q)}`);
            renderDmsResults(results, res.data, selectedAccountId);
          } catch {
            const li = document.createElement('li');
            li.className = 'form-hint';
            li.textContent = t('documents.dmsNoResults');
            results.appendChild(li);
          }
        }, 300);
      });

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
        window.oikos?.showToast(err.data?.error ?? t('common.unknownError'), 'danger');
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

  openSharedModal({
    title: esc(doc.name),
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
    onSave(panel) {
      if (window.lucide) window.lucide.createIcons({ el: panel });
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
            body.insertAdjacentHTML('beforeend', renderViewerUnsupported(doc, downloadUrl));
            if (window.lucide) window.lucide.createIcons({ el: body });
          });
      }
    },
  });
}

function renderViewerContent(doc, previewUrl, downloadUrl) {
  if (doc.mime_type === 'application/pdf') {
    // Kein `sandbox` am PDF-iframe: Chromium verweigert die Initialisierung seines internen
    // PDF-Viewers in sandboxed Frames und zeigt stattdessen "This page was blocked by Chrome".
    // Die Auslieferung erfolgt same-origin als application/pdf mit nosniff, daher keine
    // Skriptausführung im Frame.
    return `<iframe class="document-viewer__pdf" src="${previewUrl}" title="${esc(doc.name)}"></iframe>`;
  }
  if (doc.mime_type === 'image/png' || doc.mime_type === 'image/jpeg' || doc.mime_type === 'image/webp') {
    return `<img class="document-viewer__image" src="${previewUrl}" alt="${esc(doc.name)}"`
      + ` loading="lazy">`;
  }
  if (doc.mime_type === 'text/plain' || doc.mime_type === 'text/csv') {
    // Inhalt wird asynchron in onSave geladen; Platzhalter anzeigen
    return `<div class="document-viewer__loading">
      <i data-lucide="loader-circle" style="width:18px;height:18px" aria-hidden="true"></i>
      ${esc(doc.original_name)}
    </div>`;
  }
  // Nicht darstellbare Typen: nur Download
  return renderViewerUnsupported(doc, downloadUrl);
}

function renderViewerUnsupported(doc, downloadUrl) {
  return `
    <div class="document-viewer__unsupported">
      <span class="document-viewer__unsupported-icon">
        <i data-lucide="file-x" aria-hidden="true"></i>
      </span>
      <div class="document-viewer__unsupported-title">${esc(doc.original_name)}</div>
      <div class="document-viewer__unsupported-hint">${t('documents.viewerDownloadHint')}</div>
      <a class="btn btn--primary" href="${downloadUrl}" download>
        <i data-lucide="download" class="icon-md" aria-hidden="true"></i>
        ${t('documents.downloadAction')}
      </a>
    </div>
  `;
}
