/** Tag names and assignment stay live in Paperless, never in a local snapshot. */
import { api } from '/api.js';
import { t } from '/i18n.js';
import { esc } from '/utils/html.js';
import { openModal, closeModal, captureModalContext, isModalContextCurrent } from '/components/modal.js';

const ROOT = '/documents/dms/paperless';
const key = (name) => `documents.paperless.tags.${name}`;
function message(err) {
  const reason = err?.data?.reason;
  if (reason === 'paperless_tags_changed') return t(key('changed'));
  if (err?.status === 403) return t(key('forbidden'));
  if (err?.status === 404 || reason === 'paperless_folder_changed') return t('documents.paperless.errors.gone');
  if (reason === 'paperless_tags_invalid') return t(key('invalid'));
  return t('documents.paperless.errors.unavailable');
}

export function openPaperlessTags({ path, title, signal, onSaved = () => {} }) {
  openModal({
    title: t(key('title'), { name: title }), size: 'sm',
    content: `<form class="document-form" id="paperless-tags-form">
      <p class="form-hint">${esc(t(key('hint')))}</p>
      <p role="status" data-pl-tag-status>${esc(t('common.loading'))}</p>
      <label class="form-label" for="pl-tag-search">${esc(t(key('search')))}</label>
      <input type="search" class="form-input" id="pl-tag-search" disabled>
      <fieldset class="paperless-tags__choices" disabled><legend>${esc(t(key('assigned')))}</legend><div data-pl-tag-list></div></fieldset>
      <button type="button" class="btn btn--ghost btn--sm" data-pl-tag-more hidden>${esc(t(key('more')))}</button>
      <p class="form-error" role="alert" data-pl-tag-error hidden></p>
      <div class="modal-panel__footer">
        <button type="button" class="btn btn--secondary" data-pl-tag-reload>${esc(t('documents.paperless.refresh'))}</button>
        <button type="button" class="btn btn--secondary" data-action="close-modal">${esc(t('common.close'))}</button>
        <button type="submit" class="btn btn--primary" disabled hidden>${esc(t('common.save'))}</button>
      </div>
    </form>`,
    onSave(panel) {
      const context = captureModalContext();
      const current = () => !signal?.aborted && isModalContextCurrent(context);
      const form = panel.querySelector('form');
      const fieldset = panel.querySelector('fieldset');
      const list = panel.querySelector('[data-pl-tag-list]');
      const search = panel.querySelector('#pl-tag-search');
      const status = panel.querySelector('[data-pl-tag-status]');
      const error = panel.querySelector('[data-pl-tag-error]');
      const more = panel.querySelector('[data-pl-tag-more]');
      const reload = panel.querySelector('[data-pl-tag-reload]');
      const save = panel.querySelector('[type="submit"]');
      let tags = new Map();
      let selected = new Set();
      let expected = [];
      let accountId;
      let page = 0;
      let canEdit = false;
      let busy = false;
      let ready = false;
      const showError = (err) => { error.textContent = message(err); error.hidden = false; };
      function lock(value) {
        busy = value;
        save.disabled = value || !ready;
        reload.disabled = value;
        more.disabled = value;
        fieldset.disabled = value || !canEdit;
      }
      function draw() {
        const query = search.value.trim().toLocaleLowerCase();
        const rows = [...tags.values()].filter((tag) => String(tag.name).toLocaleLowerCase().includes(query));
        list.innerHTML = rows.map((tag) => `<label class="paperless-tags__choice"><input type="checkbox" value="${esc(tag.id)}" ${selected.has(tag.id) ? 'checked' : ''}> <span>${esc(tag.name)}</span></label>`).join('');
        status.textContent = t(key(selected.size ? 'selection' : 'empty'), { count: selected.size });
      }
      async function catalogue() {
        const result = await api.get(`${ROOT}/tags?account_id=${accountId}&page=${page + 1}`, { signal });
        if (!current()) return;
        page++;
        for (const tag of result.data) tags.set(tag.id, tag);
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
          selected = new Set(expected);
          tags = new Map(result.data.tags.map((tag) => [tag.id, tag]));
          accountId = result.data.account_id;
          canEdit = result.data.can_edit;
          page = 0;
          search.value = '';
          search.disabled = false;
          save.hidden = !canEdit;
          draw();
          if (canEdit) await catalogue();
          if (!current()) return;
          ready = true;
        } catch (err) { if (current()) showError(err); }
        finally { if (current()) lock(false); }
      }
      search.addEventListener('input', draw);
      list.addEventListener('change', (event) => {
        if (busy || !canEdit || !event.target.matches('input[type="checkbox"]')) return;
        const id = Number(event.target.value);
        if (event.target.checked) selected.add(id); else selected.delete(id);
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
        if (busy || !ready || !canEdit || !current()) return;
        lock(true); error.hidden = true;
        try {
          await api.put(path, { tags: [...selected], expected_tags: expected });
          if (!current()) return;
          await closeModal({ force: true, context });
          if (!signal?.aborted) await onSaved();
        } catch (err) {
          if (current()) {
            showError(err);
            if (err?.status === 409 || err?.status === 404) ready = false;
          }
        } finally { if (current()) lock(false); }
      });
      load();
    },
  });
}
