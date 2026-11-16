/** Saved Paperless views in Documents. Files and filters stay in Paperless. */
import { paperlessControl, paperlessApiError } from '/components/paperless-dom.js';
import { api } from '/api.js';
import { openPaperlessTags } from '/components/paperless-tags.js';
import { t, formatDate } from '/i18n.js';
import { esc, REQUIRED_MARK } from '/utils/html.js';
import { reloadAfterSave } from '/utils/reload-after-save.js';
import { popoverMenuHtml, installPopoverMenus } from '/utils/popover-menu.js';
import { renderUserMultiSelect, bindUserMultiSelect, getSelectedUserIds } from '/components/user-multi-select.js';
import { rowActionHtml } from '/utils/row-action.js';
import { openModal, closeModal, confirmOverModal, captureModalContext, isModalContextCurrent, refocusAfterRender, reportFieldErrors, constraintErrors } from '/components/modal.js';

/** @type {(message: string, options: {closeOnConfirm: boolean, confirmLabel: string}) => Promise<boolean>} */
const confirmFolderRemoval = /** @type {(message: string, options: {closeOnConfirm: boolean, confirmLabel: string}) => Promise<boolean>} */ (/** @type {unknown} */ (confirmOverModal));
const ROOT = '/documents/dms/paperless';
const DISPLAY_FIELDS = ['created', 'added', 'modified', 'correspondent', 'document_type', 'tags', 'archive_serial_number', 'filename'];
/** @param {import("../../types/paperless.d.ts").Document} doc @param {string[]} fields */
function overviewFields(doc, fields) {
  return fields.filter((field) => DISPLAY_FIELDS.includes(field)).map((field) => {
    let value = doc.display?.[field];
    if (typeof value === 'string' && ['created', 'added', 'modified'].includes(field)) {
      value = formatDate(field === 'created' ? value.slice(0, 10) : value) || null;
    }
    return `<div class="paperless-folder__field" data-pl-field="${field}"><dt>${esc(t(`documents.paperless.fields.${field}`))}</dt><dd>${esc(value === null || value === undefined || value === '' ? '-' : String(value))}</dd></div>`;
  }).join('');
}
/** @param {string} name */
const key = (name) => `documents.paperless.${name}`;
/** @param {Element} el */
const icons = (el) => window.lucide?.createIcons({ el });
/** @type {Record<string, string>} */
const ERRORS = {
  paperless_view_unsupported: 'unsupported', paperless_unavailable: 'unavailable',
  paperless_folder_not_found: 'gone', paperless_document_not_found: 'gone',
  paperless_account_not_found: 'gone', paperless_folder_changed: 'changed',
  paperless_share_confirmation: 'share', paperless_folder_invalid: 'invalid',
  paperless_preview_unsupported: 'preview',
};
/** @param {unknown} error */
function sentence(error) {
  const err = paperlessApiError(error);
  if (err?.data?.reason === 'paperless_personal_token_required') return t('settings.liveFolders.tokenRequired');
  if (err?.data?.reason === 'paperless_dms_forbidden') return t('settings.liveFolders.dmsForbidden');
  if (err?.status === 500) return t('common.unknownError');
  return t(key(`errors.${ERRORS[err?.data?.reason || ""] || (err?.status === 403 ? 'forbidden' : 'unavailable')}`));
}

/** @param {number | string} folderId @param {number | string} documentId @param {string} action */
function paperlessMediaPath(folderId, documentId, action) {
  return `/api/v1${ROOT}/folders/${encodeURIComponent(folderId)}/documents/${encodeURIComponent(documentId)}/${action}`;
}

/** Mount the Documents saved-view browser. */
/** @param {{sidebar: HTMLElement, content: HTMLElement, accounts?: {id: number, name: string}[], canManage?: boolean,
 * members?: {id: number, display_name: string, avatar_color: string}[], userId?: number | null, signal?: AbortSignal,
 * onActiveChange?: (active: boolean, folder?: import('../../types/paperless.d.ts').Folder) => void}} options */
export async function mountPaperlessFolders({ sidebar, content, accounts = [], canManage = false, members = [], userId = null,
  signal, onActiveChange = () => {} }) {
  /** @type {import("../../types/paperless.d.ts").Folder[]} */
  let folders = [];
  /** @type {import("../../types/paperless.d.ts").Folder | null} */
  let active = null;
  let page = 1;
  let serial = 0;
  let navSerial = 0;
  const alive = () => !signal?.aborted && sidebar.isConnected && content.isConnected;
  const options = signal ? { signal } : {};

  function close() {
    serial++;
    active = null;
    content.hidden = true;
    content.replaceChildren();
    onActiveChange(false);
    drawNav();
  }

  /** @param {unknown} [error] */
  function drawNav(error = null) {
    if (!alive()) return;
    sidebar.hidden = !folders.length && !(canManage && accounts.length) && !error;
    sidebar.replaceChildren();
    sidebar.insertAdjacentHTML('beforeend', `
      <div class="documents-folder-browser__head">
        <h2 class="documents-folder-browser__title">${esc(t(key('title')))}</h2>
        ${canManage && accounts.length ? `<button class="documents-folder-browser__add" type="button" data-pl-add aria-label="${esc(t(key('add')))}" title="${esc(t(key('add')))}"><i data-lucide="folder-plus" aria-hidden="true"></i></button>` : ''}
      </div>
      ${error ? `<p role="alert">${esc(sentence(error))}</p><button class="btn btn--secondary btn--sm" type="button" data-pl-retry>${esc(t('common.retry'))}</button>` : ''}
      <ul class="documents-folder-browser__list row-carrier">
        ${folders.map((folder) => `<li class="list-row documents-folder-item${active?.id === folder.id ? ' documents-folder-item--active' : ''}">
          <button type="button" class="documents-folder-item__select list-row__main--interactive" data-pl-folder="${folder.id}" aria-current="${active?.id === folder.id ? 'true' : 'false'}">
            <span class="documents-folder-item__icon"><i data-lucide="folder-sync" aria-hidden="true"></i></span>
            <span class="list-row__name documents-folder-item__name">${esc(folder.name)}</span>
          </button>
          ${canManage && folder.can_manage ? rowActionHtml({ icon: 'pencil', label: t(key('editNamed'), { name: folder.name }), attrs: { 'data-pl-edit': folder.id } }) : ''}
        </li>`).join('')}
      </ul>`);
    icons(sidebar);
  }

  async function refresh() {
    const mine = ++navSerial;
    try {
      const result = await api.get(`${ROOT}/folders`, { signal });
      if (!alive() || mine !== navSerial) return;
      folders = result.data || [];
      if (active && !folders.some((f) => f.id === active?.id)) close();
      drawNav();
    } catch (err) {
      if (alive() && mine === navSerial) drawNav(err);
    }
  }

  /** @param {import("../../types/paperless.d.ts").Folder} folder @param {number} [requestedPage] */
  async function show(folder, requestedPage = 1) {
    if (!alive()) return;
    const mine = ++serial;
    active = folder;
    page = requestedPage;
    content.hidden = false;
    onActiveChange(true, folder);
    drawNav();
    content.replaceChildren();
    content.insertAdjacentHTML('beforeend', `<p role="status">${esc(t('common.loading'))}</p>`);
    try {
      const result = await api.get(`${ROOT}/folders/${folder.id}/documents?page=${page}`, { signal });
      if (!alive() || mine !== serial) return;
      content.replaceChildren();
      content.insertAdjacentHTML('beforeend', `
        <div class="paperless-folder__head">
          <h2 class="paperless-folder__title" tabindex="-1">${esc(folder.name)}</h2>
          <button class="btn btn--secondary btn--sm" type="button" data-pl-refresh>${esc(t(key('refresh')))}</button>
        </div>
        <p class="form-hint">${esc(t(key('readOnly')))}</p>
        <p class="form-hint">${esc(t(`documents.visibility.${folder.visibility}`))}</p>
        <div class="row-carrier paperless-folder__documents">
          ${(result.data || []).map((/** @type {import("../../types/paperless.d.ts").Document} */ doc) => {
            const external = /^https?:\/\//i.test(doc.url || '') ? doc.url : null;
            return `<article class="list-row paperless-folder__document">
              <i data-lucide="file-text" aria-hidden="true"></i>
              <div class="paperless-folder__details"><span class="list-row__name">${esc(doc.title)}</span>
                ${result.meta.display_fields?.length ? `<dl class="paperless-folder__metadata">${overviewFields(doc, result.meta.display_fields)}</dl>` : ''}
              </div>
              <div class="paperless-folder__actions">
                <a class="btn btn--secondary btn--sm" target="_blank" rel="noopener noreferrer" href="${esc(paperlessMediaPath(folder.id, doc.id, 'preview'))}">${esc(t(key('preview')))}</a>
                ${popoverMenuHtml({ ...{ id: `pl-actions-${folder.id}-${doc.id}`, label: t('common.moreActions'), items: [
                  { action: 'pl-tags', label: t(key('tags.action')), icon: 'tags', attrs: { 'data-pl-tags': doc.id, 'data-pl-title': doc.title } },
                  { action: 'pl-download', label: t(key('download')), icon: 'download', attrs: { 'data-pl-download': paperlessMediaPath(folder.id, doc.id, 'download') } },
                  ...(external ? [{ action: 'pl-external', label: t(key('openExternal')), icon: 'external-link', attrs: { 'data-pl-external': external } }] : []),
                ] } })}
              </div>
            </article>`;
          }).join('')}
        </div>
        ${!result.data?.length ? `<p role="status">${esc(t(key('empty')))}</p>` : ''}
        <nav class="paperless-folder__pagination" aria-label="${esc(t(key('pagination')))}">
          <button class="btn btn--secondary btn--sm" type="button" data-pl-prev ${page === 1 ? 'disabled' : ''}>${esc(t(key('previous')))}</button>
          <span role="status">${esc(t(key('pageInfo'), { page, total: result.meta.count }))}</span>
          <button class="btn btn--secondary btn--sm" type="button" data-pl-next ${!result.meta.has_more ? 'disabled' : ''}>${esc(t(key('next')))}</button>
        </nav>`);
      icons(content);
      content.querySelector('h2')?.focus({ preventScroll: true });
    } catch (err) {
      if (!alive() || mine !== serial) return;
      content.replaceChildren();
      content.insertAdjacentHTML('beforeend', `<h2>${esc(folder.name)}</h2><p role="alert">${esc(sentence(err))}</p><button class="btn btn--secondary" type="button" data-pl-refresh>${esc(t('common.retry'))}</button>`);
    }
  }

  const edit = createFolderEditor({ canManage, alive, accounts, members, userId, signal, options, refresh, show,
    close, activeFolder: () => active });

  sidebar.addEventListener('click', (event) => {
    if (!(event.target instanceof Element)) return;
    const chosen = /** @type {HTMLElement | null} */ (event.target.closest('[data-pl-folder]'));
    const editButton = /** @type {HTMLElement | null} */ (event.target.closest('[data-pl-edit]'));
    if (chosen) { const folder = folders.find((f) => String(f.id) === chosen.dataset.plFolder); if (folder) show(folder); }
    else if (editButton) edit(folders.find((f) => String(f.id) === editButton.dataset.plEdit));
    else if (event.target.closest('[data-pl-add]')) edit();
    else if (event.target.closest('[data-pl-retry]')) refresh();
  }, options);
  installPopoverMenus(content);
  content.addEventListener('click', (event) => {
    if (!(event.target instanceof Element)) return;
    if (!active) return;
    const download = /** @type {HTMLElement | null} */ (event.target.closest('[data-pl-download]'));
    const external = /** @type {HTMLElement | null} */ (event.target.closest('[data-pl-external]'));
    if (download) { window.location.assign(download.dataset.plDownload || ''); return; }
    if (external) { window.open(external.dataset.plExternal || '', '_blank', 'noopener,noreferrer'); return; }
    const tags = /** @type {HTMLElement | null} */ (event.target.closest('[data-pl-tags]'));
    if (tags) {
      const folder = active;
      openPaperlessTags({ path: `${ROOT}/folders/${folder.id}/documents/${encodeURIComponent(tags.dataset.plTags || '')}/tags`,
        title: tags.dataset.plTitle || '', signal, onSaved: () => alive() && active?.id === folder.id ? show(folder, page) : undefined });
    }
    else if (event.target.closest('[data-pl-prev]')) show(active, Math.max(1, page - 1));
    else if (event.target.closest('[data-pl-next]')) show(active, page + 1);
    else if (event.target.closest('[data-pl-refresh]')) show(active, page);
  }, options);
  signal?.addEventListener('abort', () => { serial++; navSerial++; }, { once: true });
  await refresh();
  return { close, refresh };
}

/** @param {{canManage: boolean, alive: () => boolean, accounts: {id: number, name: string}[], members: {id: number, display_name: string, avatar_color: string}[],
 * userId: number | null, signal?: AbortSignal, options: AddEventListenerOptions, refresh: () => Promise<void>,
 * show: (folder: import('../../types/paperless.d.ts').Folder, page?: number) => Promise<void>, close: () => void,
 * activeFolder: () => import('../../types/paperless.d.ts').Folder | null}} context */
function createFolderEditor({ canManage, alive, accounts, members, userId, signal, options, refresh, show, close, activeFolder }) {
  /** @param {import("../../types/paperless.d.ts").Folder | null} [folder] */
  return function edit(folder = null) {
    if (!canManage || !alive()) return;
    openModal({ ...{
      title: t(key(folder ? 'edit' : 'add')), size: 'sm',
      content: `<form class="document-form" id="paperless-folder-form" novalidate>
        <div class="form-group"><label class="form-label" for="pl-name">${esc(t(key('name')))}${REQUIRED_MARK}</label><input class="form-input" id="pl-name" required maxlength="200" value="${esc(folder?.name || '')}"></div>
        ${!folder ? `<div class="form-group"><label class="form-label" for="pl-account">${esc(t(key('account')))}</label><select class="form-input" id="pl-account">${accounts.map((a) => `<option value="${a.id}">${esc(a.name)}</option>`).join('')}</select></div>
          <div class="form-group"><label class="form-label" for="pl-source">${esc(t(key('source')))}</label><select class="form-input" id="pl-source"><option value="view">${esc(t(key('savedViewSource')))}</option><option value="tags">${esc(t(key('tagSource')))}</option></select></div>
          <div data-pl-view-source class="form-group"><label class="form-label" for="pl-view">${esc(t(key('view')))}${REQUIRED_MARK}</label><select class="form-input" id="pl-view" required disabled></select><button class="btn btn--ghost btn--sm" type="button" data-pl-more-views hidden>${esc(t(key('moreViews')))}</button></div>
          <div data-pl-tag-source hidden>
            <div class="form-group"><label class="form-label" for="pl-tag-match">${esc(t(key('tagMatch')))}</label><select class="form-input" id="pl-tag-match"><option value="all">${esc(t(key('matchAll')))}</option><option value="any">${esc(t(key('matchAny')))}</option></select></div>
            <p class="form-hint">${esc(t(key('tagFilterHint')))}</p>
            <div class="paperless-tags__filter-list" data-pl-filter-tags role="group" aria-label="${esc(t(key('tags.action')))}"></div>
            <button class="btn btn--secondary btn--sm" type="button" data-pl-more-tags hidden>${esc(t(key('tags.more')))}</button>
            <button class="btn btn--secondary btn--sm" type="button" data-pl-retry-tags hidden>${esc(t('common.retry'))}</button>
          </div>` : ''}
        <div class="form-group"><label class="form-label" for="pl-visibility">${esc(t(key('visibility')))}</label><select class="form-input" id="pl-visibility">${['private', 'restricted', 'family'].map((visibility) => `<option value="${visibility}" ${(folder?.visibility || 'private') === visibility ? 'selected' : ''}>${esc(t(`documents.visibility.${visibility}`))}</option>`).join('')}</select></div>
        <div id="pl-members" hidden>${renderUserMultiSelect(members, folder?.allowed_member_ids || [], 'pl-members', 'documents.allowedMembersLabel')}</div>
        <label class="form-hint" id="pl-consent" hidden><input type="checkbox" id="pl-confirm"> ${esc(t(key('shareConsent')))}</label>
        <p class="form-hint" data-pl-source-hint>${esc(t(key(folder?.tag_filter ? 'tagFilterHint' : 'viewHint')))}</p>
        <p class="form-error" id="pl-error" role="alert" hidden></p>
        <div class="modal-panel__footer">
          ${folder ? `<button type="button" class="btn btn--danger-outline" data-pl-remove>${esc(t(key('remove')))}</button>` : ''}
          <button type="button" class="btn btn--secondary" data-action="close-modal">${esc(t('common.cancel'))}</button>
          <button type="submit" class="btn btn--primary" ${folder ? '' : 'disabled'}>${esc(t('common.save'))}</button>
        </div>
      </form>`,
      onSave(/** @type {HTMLElement} */ panel) {
        const modalContext = captureModalContext();
        const current = () => alive() && isModalContextCurrent(modalContext);
        const error = /** @type {HTMLElement} */ (paperlessControl(panel, '#pl-error'));
        const submit = /** @type {HTMLButtonElement} */ (paperlessControl(panel, '[type="submit"]'));
        bindUserMultiSelect(panel, 'pl-members');
        const visibility = /** @type {HTMLSelectElement} */ (paperlessControl(panel, '#pl-visibility'));
        const consent = /** @type {HTMLElement} */ (paperlessControl(panel, '#pl-consent'));
        const confirm = /** @type {HTMLInputElement} */ (paperlessControl(panel, '#pl-confirm'));
        const updateAudience = () => {
          const selected = getSelectedUserIds(panel, 'pl-members');
          const wider = folder?.visibility !== 'family' && (visibility.value === 'family'
            || (visibility.value === 'restricted' && selected.some((id) => id !== userId
              && !folder?.allowed_member_ids?.includes(id))));
          /** @type {HTMLElement} */ (paperlessControl(panel, '#pl-members')).hidden = visibility.value !== 'restricted';
          consent.hidden = !wider;
          confirm.checked = false;
          confirm.required = wider;
        };
        visibility.addEventListener('change', updateAudience, options);
        /** @type {HTMLElement} */ (paperlessControl(panel, '#pl-members')).addEventListener('change', updateAudience, options);
        updateAudience();
        /** @param {unknown} err */
        const showError = (err) => { error.textContent = sentence(err); error.hidden = false; };
        const { selectedTags, tagSource } = folder ? { selectedTags: new Set(), tagSource: () => false }
          : bindFolderSourcePicker({ panel, current, signal, options, submit, showError, error });
        panel.querySelector('[data-pl-remove]')?.addEventListener('click', async () => {
          if (!current()) return;
          if (!folder) return;
          const yes = await confirmFolderRemoval(t(key('removeConfirm'), { name: folder.name }), { closeOnConfirm: false, confirmLabel: t(key('remove')) });
          if (!yes || !alive()) return;
          try {
            await api.delete(`${ROOT}/folders/${folder.id}`);
            await closeModal({ force: true, context: modalContext });
            if (!alive()) return;
            if (activeFolder()?.id === folder.id) close();
            await reloadAfterSave(() => refresh());
            refocusAfterRender();
          } catch (err) { if (alive()) window.yuvomi?.showToast(sentence(err), 'danger'); }
        }, options);
        /** @type {HTMLFormElement} */ (paperlessControl(panel, 'form')).addEventListener('submit', async (event) => {
          event.preventDefault();
          if (!current() || submit.disabled) return;
          if (reportFieldErrors(constraintErrors(/** @type {HTMLFormElement} */ (event.currentTarget)))) return;
          /** @type {{name: string, visibility: string, confirm_share: boolean, allowed_member_ids: number[], account_id?: number, view_id?: number, tag_filter?: {tag_ids: number[], match: string}}} */
          const body = {
            name: /** @type {HTMLInputElement} */ (paperlessControl(panel, '#pl-name')).value.trim(),
            visibility: /** @type {HTMLSelectElement} */ (paperlessControl(panel, '#pl-visibility')).value,
            confirm_share: /** @type {HTMLInputElement} */ (paperlessControl(panel, '#pl-confirm')).checked,
            allowed_member_ids: getSelectedUserIds(panel, 'pl-members'),
          };
          if (!folder) {
            body.account_id = Number(/** @type {HTMLSelectElement} */ (paperlessControl(panel, '#pl-account')).value);
            if (tagSource()) body.tag_filter = { tag_ids: [...selectedTags],
              match: /** @type {HTMLSelectElement} */ (paperlessControl(panel, '#pl-tag-match')).value };
            else body.view_id = Number(/** @type {HTMLSelectElement} */ (paperlessControl(panel, '#pl-view')).value);
          }
          submit.disabled = true;
          error.hidden = true;
          try {
            const result = folder ? await api.put(`${ROOT}/folders/${folder.id}`, body) : await api.post(`${ROOT}/folders`, body);
            if (!current()) return;
            await closeModal({ force: true, context: modalContext });
            await reloadAfterSave(() => refresh());
            if (alive()) {
              await show(result.data);
              refocusAfterRender();
            }
          } catch (err) { if (current()) showError(err); }
          finally { if (current()) submit.disabled = false; }
        }, options);
      },
    } });
  }

}

/** @param {{panel: HTMLElement, current: () => boolean, signal?: AbortSignal, options: AddEventListenerOptions,
 * submit: HTMLButtonElement, showError: (error: unknown) => void, error: HTMLElement}} context */
function bindFolderSourcePicker({ panel, current, signal, options, submit, showError, error }) {
  const sourceSelect = /** @type {HTMLSelectElement | null} */ (panel.querySelector('#pl-source'));
  const tagSource = () => sourceSelect?.value === 'tags';
  /** @type {Set<number>} */
  const selectedTags = new Set();
  let tagsPage = 0, tagsSerial = 0, tagsLoading = false;
  const loadFilterTags = async (append = false) => {
    const mine = ++tagsSerial;
    const accountId = /** @type {HTMLSelectElement} */ (paperlessControl(panel, '#pl-account')).value;
    const list = /** @type {HTMLElement} */ (paperlessControl(panel, '[data-pl-filter-tags]'));
    const more = /** @type {HTMLButtonElement} */ (paperlessControl(panel, '[data-pl-more-tags]'));
    const retry = /** @type {HTMLButtonElement} */ (paperlessControl(panel, '[data-pl-retry-tags]'));
    if (!append) { tagsPage = 0; selectedTags.clear(); list.replaceChildren(); }
    tagsLoading = true; submit.disabled = true; more.disabled = true; retry.hidden = true; error.hidden = true;
    try {
      const result = await api.get(`${ROOT}/filter-tags?account_id=${accountId}&page=${tagsPage + 1}`, { signal });
      if (!current() || mine !== tagsSerial || !tagSource()) return;
      tagsPage++;
      for (const tag of result.data) {
        const label = document.createElement('label');
        label.className = 'paperless-tags__choice';
        const input = document.createElement('input');
        input.type = 'checkbox'; input.value = String(tag.id);
        input.checked = selectedTags.has(tag.id);
        input.addEventListener('change', () => {
          if (input.checked) selectedTags.add(tag.id); else selectedTags.delete(tag.id);
          submit.disabled = tagsLoading || !selectedTags.size;
        }, options);
        label.append(input, document.createTextNode(` ${tag.name} (#${tag.id})`));
        list.append(label);
      }
      more.hidden = !result.meta.has_more;
      if (!list.childElementCount) { error.textContent = t(key('tags.empty')); error.hidden = false; }
    } catch (err) { if (current() && mine === tagsSerial && tagSource()) { showError(err); retry.hidden = false; } }
    finally { if (current() && mine === tagsSerial && tagSource()) {
      tagsLoading = false; more.disabled = false; submit.disabled = !selectedTags.size;
    } }
  };
  let viewsPage = 0;
  let viewsSerial = 0;
  /** @type {string | null} */
  let viewsAccount = null;
  const loadViews = async (append = false) => {
    const accountSelect = /** @type {HTMLSelectElement} */ (paperlessControl(panel, '#pl-account'));
    const viewSelect = /** @type {HTMLSelectElement} */ (paperlessControl(panel, '#pl-view'));
    const more = /** @type {HTMLButtonElement} */ (paperlessControl(panel, '[data-pl-more-views]'));
    const mine = ++viewsSerial;
    const accountId = accountSelect.value;
    submit.disabled = true;
    more.disabled = true;
    error.hidden = true;
    if (!append || viewsAccount !== accountId) {
      viewsAccount = accountId;
      viewsPage = 0;
      viewSelect.replaceChildren();
      viewSelect.disabled = true;
    }
    try {
      const result = await api.get(`${ROOT}/saved-views?account_id=${accountId}&page=${viewsPage + 1}`, { signal });
      if (!current() || mine !== viewsSerial || tagSource()) return;
      viewsPage++;
      for (const view of result.data) {
        const option = document.createElement('option');
        option.value = String(view.id);
        option.textContent = view.name;
        viewSelect.append(option);
      }
      viewSelect.disabled = false;
      submit.disabled = false;
      more.hidden = !result.meta.has_more;
      if (!viewSelect.options.length) error.textContent = t(key('noViews'));
      error.hidden = viewSelect.options.length > 0;
    } catch (err) { if (current() && mine === viewsSerial && !tagSource()) showError(err); }
    finally {
      if (current() && mine === viewsSerial && !tagSource()) {
        more.disabled = false;
        viewSelect.disabled = false;
        submit.disabled = false;
      }
    }
  };
  const updateSource = () => {
    viewsSerial++; tagsSerial++;
    const byTags = tagSource();
    /** @type {HTMLElement} */ (paperlessControl(panel, '[data-pl-source-hint]')).hidden = byTags;
    /** @type {HTMLElement} */ (paperlessControl(panel, '[data-pl-view-source]')).hidden = byTags;
    /** @type {HTMLElement} */ (paperlessControl(panel, '[data-pl-tag-source]')).hidden = !byTags;
    const viewInput = /** @type {HTMLSelectElement} */ (paperlessControl(panel, '#pl-view'));
    viewInput.required = !byTags; viewInput.disabled = byTags;
    if (byTags) loadFilterTags(); else loadViews();
  };
  sourceSelect?.addEventListener('change', updateSource, options);
  panel.querySelector('#pl-account')?.addEventListener('change', updateSource, options);
  panel.querySelector('[data-pl-more-tags]')?.addEventListener('click', () => loadFilterTags(true), options);
  panel.querySelector('[data-pl-retry-tags]')?.addEventListener('click', () => loadFilterTags(tagsPage > 0), options);
  panel.querySelector('[data-pl-more-views]')?.addEventListener('click', () => loadViews(true), options);
  panel.querySelector('#pl-view')?.addEventListener('change', (e) => {
    if (!/** @type {HTMLInputElement} */ (paperlessControl(panel, '#pl-name')).value.trim()) /** @type {HTMLInputElement} */ (paperlessControl(panel, '#pl-name')).value = (/** @type {HTMLSelectElement} */ (e.target)).selectedOptions[0]?.textContent || '';
  }, options);
  loadViews();
  return { selectedTags, tagSource };
}
