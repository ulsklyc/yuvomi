/** Saved Paperless views in Documents. Files and filters stay in Paperless. */
import { api } from '/api.js';
import { openPaperlessTags } from '/components/paperless-tags.js';
import { t } from '/i18n.js';
import { esc, REQUIRED_MARK } from '/utils/html.js';
import { reloadAfterSave } from '/utils/reload-after-save.js';
import { rowActionHtml } from '/utils/row-action.js';
import { openModal, closeModal, confirmOverModal, captureModalContext, isModalContextCurrent, reportFieldErrors, constraintErrors } from '/components/modal.js';

const ROOT = '/documents/dms/paperless';
const key = (name) => `documents.paperless.${name}`;
const icons = (el) => window.lucide?.createIcons({ el });
const ERRORS = {
  paperless_view_unsupported: 'unsupported', paperless_unavailable: 'unavailable',
  paperless_folder_not_found: 'gone', paperless_document_not_found: 'gone',
  paperless_account_not_found: 'gone', paperless_folder_changed: 'changed',
  paperless_share_confirmation: 'share', paperless_folder_invalid: 'invalid',
  paperless_preview_unsupported: 'preview',
};
function sentence(err) {
  if (err?.status === 500) return t('common.unknownError');
  return t(key(`errors.${ERRORS[err?.data?.reason] || (err?.status === 403 ? 'forbidden' : 'unavailable')}`));
}

export function paperlessMediaPath(folderId, documentId, action) {
  return `/api/v1${ROOT}/folders/${encodeURIComponent(folderId)}/documents/${encodeURIComponent(documentId)}/${action}`;
}

/** The same browser component can also be hosted by a module page. */
export async function mountPaperlessFolders({ sidebar, content, accounts = [], canManage = false,
  signal, onActiveChange = () => {} }) {
  let folders = [];
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
      if (active && !folders.some((f) => f.id === active.id)) close();
      drawNav();
    } catch (err) {
      if (alive() && mine === navSerial) drawNav(err);
    }
  }

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
        <p class="form-hint">${esc(t(key(folder.visibility === 'family' ? 'shared' : 'private')))}</p>
        <div class="row-carrier paperless-folder__documents">
          ${(result.data || []).map((doc) => {
            const external = /^https?:\/\//i.test(doc.url || '') ? doc.url : null;
            return `<article class="list-row paperless-folder__document">
              <i data-lucide="file-text" aria-hidden="true"></i>
              <span class="list-row__name">${esc(doc.title)}</span>
              <div class="paperless-folder__actions">
                <button class="btn btn--secondary btn--sm" type="button" data-pl-tags="${esc(doc.id)}" data-pl-title="${esc(doc.title)}">${esc(t(key('tags.action')))}</button>
                <a class="btn btn--secondary btn--sm" target="_blank" rel="noopener noreferrer" href="${esc(paperlessMediaPath(folder.id, doc.id, 'preview'))}">${esc(t(key('preview')))}</a>
                <a class="btn btn--ghost btn--sm" href="${esc(paperlessMediaPath(folder.id, doc.id, 'download'))}">${esc(t(key('download')))}</a>
                ${external ? `<a class="btn btn--ghost btn--sm" target="_blank" rel="noopener noreferrer" href="${esc(external)}">${esc(t(key('openExternal')))}</a>` : ''}
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
      content.querySelector('.paperless-folder__title')?.focus({ preventScroll: true });
    } catch (err) {
      if (!alive() || mine !== serial) return;
      content.replaceChildren();
      content.insertAdjacentHTML('beforeend', `<h2>${esc(folder.name)}</h2><p role="alert">${esc(sentence(err))}</p><button class="btn btn--secondary" type="button" data-pl-refresh>${esc(t('common.retry'))}</button>`);
    }
  }

  function edit(folder = null) {
    if (!canManage || !alive()) return;
    openModal({
      title: t(key(folder ? 'edit' : 'add')), size: 'sm',
      content: `<form class="document-form" id="paperless-folder-form" novalidate>
        <div class="form-group"><label class="form-label" for="pl-name">${esc(t(key('name')))}${REQUIRED_MARK}</label><input class="form-input" id="pl-name" required maxlength="200" value="${esc(folder?.name || '')}"></div>
        ${!folder ? `<div class="form-group"><label class="form-label" for="pl-account">${esc(t(key('account')))}</label><select class="form-input" id="pl-account">${accounts.map((a) => `<option value="${a.id}">${esc(a.name)}</option>`).join('')}</select></div>
          <div class="form-group"><label class="form-label" for="pl-view">${esc(t(key('view')))}${REQUIRED_MARK}</label><select class="form-input" id="pl-view" required disabled></select><button class="btn btn--ghost btn--sm" type="button" data-pl-more-views hidden>${esc(t(key('moreViews')))}</button></div>` : ''}
        <div class="form-group"><label class="form-label" for="pl-visibility">${esc(t(key('visibility')))}</label><select class="form-input" id="pl-visibility"><option value="private" ${folder?.visibility !== 'family' ? 'selected' : ''}>${esc(t(key('private')))}</option><option value="family" ${folder?.visibility === 'family' ? 'selected' : ''}>${esc(t(key('shared')))}</option></select></div>
        <label class="form-hint"><input type="checkbox" id="pl-confirm"> ${esc(t(key('shareConsent')))}</label>
        <p class="form-hint">${esc(t(key('viewHint')))}</p>
        <p class="form-error" id="pl-error" role="alert" hidden></p>
        <div class="modal-panel__footer">
          ${folder ? `<button type="button" class="btn btn--danger-outline" data-pl-remove>${esc(t(key('remove')))}</button>` : ''}
          <button type="button" class="btn btn--secondary" data-action="close-modal">${esc(t('common.cancel'))}</button>
          <button type="submit" class="btn btn--primary" ${folder ? '' : 'disabled'}>${esc(t('common.save'))}</button>
        </div>
      </form>`,
      onSave(panel) {
        const modalContext = captureModalContext();
        const current = () => alive() && isModalContextCurrent(modalContext);
        const error = panel.querySelector('#pl-error');
        const submit = panel.querySelector('[type="submit"]');
        const showError = (err) => { error.textContent = sentence(err); error.hidden = false; };
        let viewsPage = 0;
        let viewsSerial = 0;
        let viewsAccount = null;
        const loadViews = async (append = false) => {
          const accountSelect = panel.querySelector('#pl-account');
          const viewSelect = panel.querySelector('#pl-view');
          const more = panel.querySelector('[data-pl-more-views]');
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
            if (!current() || mine !== viewsSerial) return;
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
          } catch (err) { if (current() && mine === viewsSerial) showError(err); }
          finally {
            if (current() && mine === viewsSerial) {
              more.disabled = false;
              viewSelect.disabled = false;
              submit.disabled = false;
            }
          }
        };
        panel.querySelector('#pl-account')?.addEventListener('change', () => loadViews(), options);
        panel.querySelector('[data-pl-more-views]')?.addEventListener('click', () => loadViews(true), options);
        panel.querySelector('#pl-view')?.addEventListener('change', (e) => {
          if (!panel.querySelector('#pl-name').value.trim()) panel.querySelector('#pl-name').value = e.target.selectedOptions[0]?.textContent || '';
        }, options);
        if (!folder) loadViews();
        panel.querySelector('[data-pl-remove]')?.addEventListener('click', async () => {
          if (!current()) return;
          const yes = await confirmOverModal(t(key('removeConfirm'), { name: folder.name }), { closeOnConfirm: false, confirmLabel: t(key('remove')) });
          if (!yes || !alive()) return;
          try {
            await api.delete(`${ROOT}/folders/${folder.id}`);
            await closeModal({ force: true, context: modalContext });
            if (!alive()) return;
            if (active?.id === folder.id) close();
            await reloadAfterSave(() => refresh());
          } catch (err) { if (alive()) window.yuvomi?.showToast(sentence(err), 'danger'); }
        }, options);
        panel.querySelector('form').addEventListener('submit', async (event) => {
          event.preventDefault();
          if (!current() || submit.disabled) return;
          if (reportFieldErrors(constraintErrors(event.currentTarget))) return;
          const body = {
            name: panel.querySelector('#pl-name').value.trim(),
            visibility: panel.querySelector('#pl-visibility').value,
            confirm_share: panel.querySelector('#pl-confirm').checked,
          };
          if (!folder) {
            body.account_id = Number(panel.querySelector('#pl-account').value);
            body.view_id = Number(panel.querySelector('#pl-view').value);
          }
          submit.disabled = true;
          error.hidden = true;
          try {
            const result = folder ? await api.put(`${ROOT}/folders/${folder.id}`, body) : await api.post(`${ROOT}/folders`, body);
            if (!current()) return;
            await closeModal({ force: true, context: modalContext });
            await reloadAfterSave(() => refresh());
            if (alive()) await show(result.data);
          } catch (err) { if (current()) showError(err); }
          finally { if (current()) submit.disabled = false; }
        }, options);
      },
    });
  }

  sidebar.addEventListener('click', (event) => {
    const chosen = event.target.closest('[data-pl-folder]');
    const editButton = event.target.closest('[data-pl-edit]');
    if (chosen) { const folder = folders.find((f) => String(f.id) === chosen.dataset.plFolder); if (folder) show(folder); }
    else if (editButton) edit(folders.find((f) => String(f.id) === editButton.dataset.plEdit));
    else if (event.target.closest('[data-pl-add]')) edit();
    else if (event.target.closest('[data-pl-retry]')) refresh();
  }, options);
  content.addEventListener('click', (event) => {
    if (!active) return;
    const tags = event.target.closest('[data-pl-tags]');
    if (tags) {
      const folder = active;
      openPaperlessTags({ path: `${ROOT}/folders/${folder.id}/documents/${encodeURIComponent(tags.dataset.plTags)}/tags`,
        title: tags.dataset.plTitle, signal, onSaved: () => alive() && active?.id === folder.id ? show(folder, page) : undefined });
    }
    else if (event.target.closest('[data-pl-prev]')) show(active, Math.max(1, page - 1));
    else if (event.target.closest('[data-pl-next]')) show(active, page + 1);
    else if (event.target.closest('[data-pl-refresh]')) show(active, page);
  }, options);
  signal?.addEventListener('abort', () => { serial++; navSerial++; }, { once: true });
  await refresh();
  return { close, refresh };
}
