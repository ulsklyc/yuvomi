/** Tag names and assignment stay live in Paperless, never in a local snapshot. */
import { reloadAfterSave } from '/utils/reload-after-save.js';
import { paperlessControl, paperlessApiError } from '/components/paperless-dom.js';
import { api } from '/api.js';
import { t } from '/i18n.js';
import { esc } from '/utils/html.js';
import { renderPageSearch, wirePageSearch } from '/utils/page-search.js';
import { openModal, closeModal, refocusAfterRender, captureModalContext, isModalContextCurrent } from '/components/modal.js';

const ROOT = '/documents/dms/paperless';
/** @param {string} name */
const key = (name) => `documents.paperless.tags.${name}`;
/** @param {unknown} error */
function message(error) {
  const err = paperlessApiError(error);
  const reason = err?.data?.reason;
  if (reason === 'paperless_tags_changed') return t(key('changed'));
  if (reason === 'paperless_personal_token_required') return t('settings.liveFolders.tokenRequired');
  if (err?.status === 403) return t(key('forbidden'));
  if (err?.status === 404 || reason === 'paperless_folder_changed') return t('documents.paperless.errors.gone');
  if (reason === 'paperless_tags_restricted') return t('settings.liveFolders.tagsRestricted');
  if (reason === 'paperless_tags_invalid') return t(key('invalid'));
  return t('documents.paperless.errors.unavailable');
}

/** @param {{path: string, title: string, signal?: AbortSignal, onSaved?: () => unknown}} options */
export function openPaperlessTags({ path, title, signal, onSaved = () => {} }) {
  openModal({ ...{
    title: t(key('title'), { name: title }), size: 'sm',
    content: `<form class="document-form" id="paperless-tags-form" novalidate>
      <p class="form-hint">${esc(t(key('hint')))}</p>
      <p role="status" data-pl-tag-status>${esc(t('common.loading'))}</p>
      ${renderPageSearch({ ...{ id: 'pl-tag-search', label: t(key('search')), clearLabel: t('common.searchClear') } })}
      <fieldset class="paperless-tags__choices" disabled><legend>${esc(t(key('assigned')))}</legend><div data-pl-tag-list></div></fieldset>
      <button type="button" class="btn btn--ghost btn--sm" data-pl-tag-more hidden>${esc(t(key('more')))}</button>
      <p class="form-hint" role="status" data-pl-tag-names-warning hidden>${esc(t('settings.liveFolders.tagNamesUnavailable'))}</p>
      <p class="form-error" role="alert" data-pl-tag-error hidden></p>
      <div class="modal-panel__footer">
        <button type="button" class="btn btn--secondary" data-pl-tag-reload>${esc(t('documents.paperless.refresh'))}</button>
        <button type="button" class="btn btn--secondary" data-action="close-modal">${esc(t('common.close'))}</button>
        <button type="submit" class="btn btn--primary" disabled hidden>${esc(t('common.save'))}</button>
      </div>
    </form>`,
    onSave(/** @type {HTMLElement} */ panel) {
      const context = captureModalContext();
      const current = () => !signal?.aborted && isModalContextCurrent(context);
      const form = /** @type {HTMLFormElement} */ (paperlessControl(panel, 'form'));
      const fieldset = /** @type {HTMLFieldSetElement} */ (paperlessControl(panel, 'fieldset'));
      const list = /** @type {HTMLElement} */ (paperlessControl(panel, '[data-pl-tag-list]'));
      const search = /** @type {HTMLInputElement} */ (paperlessControl(panel, '#pl-tag-search'));
      const status = /** @type {HTMLElement} */ (paperlessControl(panel, '[data-pl-tag-status]'));
      const error = /** @type {HTMLElement} */ (paperlessControl(panel, '[data-pl-tag-error]'));
      const namesWarning = /** @type {HTMLElement} */ (paperlessControl(panel, '[data-pl-tag-names-warning]'));
      const more = /** @type {HTMLButtonElement} */ (paperlessControl(panel, '[data-pl-tag-more]'));
      const reload = /** @type {HTMLButtonElement} */ (paperlessControl(panel, '[data-pl-tag-reload]'));
      const save = /** @type {HTMLButtonElement} */ (paperlessControl(panel, '[type="submit"]'));
      /** @type {Map<number, import("../../types/paperless.d.ts").Tag>} */
      let tags = new Map();
      /** @type {Set<number>} */
      let selected = new Set();
      /** @type {number[]} */
      let expected = [];
      /** @type {Set<number>} */
      let unresolved = new Set();
      /** @type {number | undefined} */
      let accountId;
      /** @type {number | undefined} */
      let catalogueFolderId;
      /** @type {number[] | null} */
      let editableTagIds = null;
      let page = 0;
      let canEdit = false;
      let busy = false;
      let ready = false;
      /** @param {unknown} err */
      const showError = (err) => { error.textContent = message(err); error.hidden = false; };
      /** @param {boolean} value */
      function lock(value) {
        busy = value;
        // Only an in-flight operation locks Save. Readiness is checked on
        // submit so a failed load remains retryable with an explicit message.
        if (value) save.disabled = true;
        else save.disabled = false;
        reload.disabled = value;
        more.disabled = value;
        fieldset.disabled = value || !canEdit || !ready;
      }
      function draw() {
        namesWarning.hidden = unresolved.size === 0;
        const query = search.value.trim().toLocaleLowerCase();
        const rows = [...tags.values()].filter((tag) => String(tag.name).toLocaleLowerCase().includes(query) || String(tag.id).includes(query));
        list.replaceChildren();
        list.insertAdjacentHTML('beforeend', rows.map((tag) => `<label class="paperless-tags__choice"><input type="checkbox" value="${esc(tag.id)}" ${selected.has(tag.id) ? 'checked' : ''} ${editableTagIds !== null && !editableTagIds.includes(tag.id) ? 'disabled' : ''}> <span>${esc(tag.name)}${tag.name === `#${tag.id}` ? '' : ` (#${esc(tag.id)})`}</span></label>`).join(''));
        status.textContent = t(key(selected.size ? 'selection' : 'empty'), { count: selected.size });
      }
      async function catalogue() {
        const result = await api.get(`${ROOT}/tags?account_id=${accountId}&page=${page + 1}${catalogueFolderId ? `&folder_id=${catalogueFolderId}` : ''}`, { signal });
        if (!current()) return;
        page++;
        for (const tag of result.data) { tags.set(tag.id, tag); unresolved.delete(tag.id); }
        more.hidden = !result.meta.has_more;
        draw();
      }
      async function load() {
        if (busy || !current()) return;
        ready = false;
        lock(true);
        error.hidden = true;
        more.hidden = true;
        status.textContent = t('common.loading');
        try {
          const result = await api.get(path, { signal });
          if (!current()) return;
          expected = result.data.tag_ids;
          unresolved = new Set(result.data.unresolved_tag_ids || []);
          selected = new Set(expected);
          tags = new Map(result.data.tags.map((/** @type {import("../../types/paperless.d.ts").Tag} */ tag) => [tag.id, tag]));
          accountId = result.data.account_id;
          catalogueFolderId = result.data.catalogue_folder_id;
          editableTagIds = result.data.editable_tag_ids ?? null;
          canEdit = result.data.can_edit;
          page = 0;
          searchControl?.setValue('');
          search.disabled = false;
          save.hidden = !canEdit;
          draw();
          if (canEdit) await catalogue();
          if (!current()) return;
          ready = true;
        } catch (err) { if (current()) showError(err); }
        finally { if (current()) lock(false); }
      }
      const searchControl = wirePageSearch(panel, { id: 'pl-tag-search', onQuery: draw, delay: 0 });
      list.addEventListener('change', (event) => {
        const input = /** @type {HTMLInputElement | null} */ (event.target);
        if (busy || !canEdit || !input || !input.matches('input[type="checkbox"]')) return;
        const id = Number(input.value);
        if (input.checked) selected.add(id); else selected.delete(id);
        status.textContent = t(key(selected.size ? 'selection' : 'empty'), { count: selected.size });
      });
      reload.addEventListener('click', load);
      more.addEventListener('click', async () => {
        if (busy || !ready || !canEdit) return;
        lock(true); error.hidden = true;
        try { await catalogue(); } catch (err) { if (current()) showError(err); }
        finally { if (current()) lock(false); }
      });
      form.addEventListener('submit', async (event) => {
        event.preventDefault();
        if (busy || !canEdit || !current()) return;
        if (!ready) { await load(); return; }
        lock(true); error.hidden = true;
        try {
          await api.put(path, { tags: [...selected], expected_tags: expected });
          if (!current()) return;
          await closeModal({ force: true, context });
          if (!signal?.aborted) {
            await reloadAfterSave(async () => {
              await onSaved();
              refocusAfterRender();
            });
          }
        } catch (err) {
          if (current()) {
            showError(err);
            if ([409, 404].includes(paperlessApiError(err)?.status || 0)) ready = false;
          }
        } finally { if (current()) lock(false); }
      });
      load();
    },
  } });
}
