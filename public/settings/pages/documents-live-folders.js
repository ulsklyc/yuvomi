import { paperlessControl, paperlessApiError } from '/components/paperless-dom.js';
import { api } from '/api.js';
import { t } from '/i18n.js';
import { esc } from '/utils/html.js';
import { settingRowHtml, settingSwitchRowHtml, bindInstantSwitch, createInlineError, createRetryState } from '/settings/components.js';
import { reportFieldErrors, constraintErrors } from '/components/modal.js';

const ROOT = '/documents/dms/paperless';
const DISPLAY_FIELDS = ['created', 'added', 'modified', 'correspondent', 'document_type', 'tags', 'archive_serial_number', 'filename'];
/** @param {string} name */
const key = (name) => `settings.liveFolders.${name}`;
/** @param {string} name */
const text = (name) => t(key(name));
/** @param {unknown} error */
function message(error) {
  const err = paperlessApiError(error);
  const reason = err?.data?.reason;
  if (reason === 'paperless_folder_changed') return t('documents.paperless.errors.changed');
  if (reason === 'paperless_tag_names_unavailable') return text('tagNamesUnavailable');
  if (reason === 'paperless_unavailable') return t('documents.paperless.errors.unavailable');
  if (reason === 'paperless_personal_token_invalid') return text('invalidToken');
  return text('error');
}

/** @param {{id: number, name: string, token_mode: string, has_personal_token: boolean, allowed_tag_ids: number[] | null, display_fields?: string[], revision: number}} account
 * @param {{canManage: boolean, signal?: AbortSignal}} options */
function buildAccount(account, { canManage, signal }) {
  const section = Object.assign(document.createElement('section'), { loadInitialTags: /** @type {(() => Promise<void>) | undefined} */ (undefined) });
  section.className = 'settings-card';
  section.insertAdjacentHTML('beforeend', `<h3 class="settings-section__title">${esc(account.name)}</h3>`);
  const current = () => !signal?.aborted && section.isConnected;
  const options = signal ? { signal } : {};
  const own = document.createElement('form');
  own.noValidate = true;
  own.className = 'settings-form settings-form--compact';
  own.autocomplete = 'off';
  const tokenId = `live-token-${account.id}`;
  own.insertAdjacentHTML('beforeend', `
    <p class="form-hint">${esc(text('personalHint'))}</p>
    <p class="form-hint" data-token-status></p>
    <div class="row-carrier settings-group">${settingRowHtml({
      label: text('myToken'), labelFor: tokenId,
      control: `<input class="form-input" type="password" id="${tokenId}" maxlength="500" required autocomplete="new-password">`,
    })}</div>
    <div data-token-error role="alert"></div>
    <div class="settings-form-actions">
      <button type="button" class="btn btn--secondary" data-delete-token>${esc(text('deleteToken'))}</button>
      <button type="submit" class="btn btn--primary">${esc(text('saveToken'))}</button>
    </div>`);
  const status = /** @type {HTMLElement} */ (paperlessControl(own, '[data-token-status]'));
  const remove = /** @type {HTMLButtonElement} */ (paperlessControl(own, '[data-delete-token]'));
  const tokenInput = /** @type {HTMLInputElement} */ (paperlessControl(own, 'input'));
  const tokenError = /** @type {HTMLElement} */ (paperlessControl(own, '[data-token-error]'));
  const updateOwn = () => {
    own.hidden = account.token_mode !== 'personal';
    status.textContent = text(account.has_personal_token ? 'tokenSet' : 'tokenMissing');
    remove.hidden = !account.has_personal_token;
  };
  own.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!current() || reportFieldErrors(constraintErrors(own))) return;
    const submit = /** @type {HTMLButtonElement} */ (paperlessControl(own, '[type="submit"]'));
    submit.disabled = true;
    tokenError.replaceChildren();
    try {
      await api.put(`${ROOT}/live-settings/${account.id}/token`, { api_token: tokenInput.value });
      if (!current()) return;
      tokenInput.value = '';
      account.has_personal_token = true;
      updateOwn();
      window.yuvomi?.showToast(text('saved'), 'success');
    } catch (err) { if (current()) tokenError.replaceChildren(createInlineError(message(err))); }
    finally { if (current()) submit.disabled = false; }
  }, options);
  remove.addEventListener('click', async () => {
    remove.disabled = true;
    tokenError.replaceChildren();
    try {
      await api.delete(`${ROOT}/live-settings/${account.id}/token`);
      if (!current()) return;
      tokenInput.value = '';
      account.has_personal_token = false;
      updateOwn();
    } catch (err) { if (current()) tokenError.replaceChildren(createInlineError(message(err))); }
    finally { if (current()) remove.disabled = false; }
  }, options);

  if (canManage) {
    const form = document.createElement('form');
    form.noValidate = true;
    form.className = 'settings-form settings-form--compact';
    const modeId = `live-mode-${account.id}`, tagsId = `live-tags-mode-${account.id}`;
    form.insertAdjacentHTML('beforeend', `
      <div class="row-carrier settings-group">
        ${settingRowHtml({ label: t('settings.liveFolders.tokenMode'), labelFor: modeId, description: text('tokenModeHint'),
          control: `<select class="form-input" id="${modeId}"><option value="shared">${esc(text('shared'))}</option><option value="personal">${esc(text('personal'))}</option></select>` })}
        ${settingRowHtml({ label: t('settings.liveFolders.tags'), labelFor: tagsId, description: text('tagsHint'),
          control: `<select class="form-input" id="${tagsId}"><option value="all">${esc(text('allTags'))}</option><option value="selected">${esc(text('selectedTags'))}</option></select>` })}
      </div>
      <h4 class="settings-group__title" id="live-fields-${account.id}">${esc(t('settings.liveFolders.displayFields'))}</h4>
      <div class="row-carrier settings-group" data-display-fields role="group" aria-labelledby="live-fields-${account.id}">
        ${DISPLAY_FIELDS.map((field) => settingSwitchRowHtml({ label: t(`documents.paperless.fields.${field}`),
          checked: account.display_fields?.includes(field), attrs: { value: field, 'data-instant-save': '' } })).join('')}
      </div>
      <p class="settings-group__footer form-hint">${esc(text('displayFieldsHint'))}</p>
      <div data-tags-picker>
        <h4 class="settings-group__title" id="live-tags-${account.id}">${esc(text('tags'))}</h4>
        <div class="row-carrier settings-group live-folder-settings__tags" data-tags-list role="group" aria-labelledby="live-tags-${account.id}"></div>
        <button type="button" class="btn btn--secondary btn--sm" data-more-tags>${esc(t('documents.paperless.tags.more'))}</button>
      </div>
      <div data-policy-error role="alert"></div>
      <div class="settings-form-actions"><button type="submit" class="btn btn--primary">${esc(t('common.save'))}</button></div>`);
    const mode = /** @type {HTMLSelectElement} */ (paperlessControl(form, `#${modeId}`));
    const tagsMode = /** @type {HTMLSelectElement} */ (paperlessControl(form, `#${tagsId}`));
    const list = /** @type {HTMLElement} */ (paperlessControl(form, '[data-tags-list]'));
    const more = /** @type {HTMLButtonElement} */ (paperlessControl(form, '[data-more-tags]'));
    const error = /** @type {HTMLElement} */ (paperlessControl(form, '[data-policy-error]'));
    const selected = new Set(account.allowed_tag_ids || []);
    /** @type {Map<number, string>} */
    const tags = new Map();
    let page = 0, loading = false;
    mode.value = account.token_mode;
    tagsMode.value = account.allowed_tag_ids === null ? 'all' : 'selected';
    function drawTags() {
      list.replaceChildren();
      for (const id of new Set([...selected, ...tags.keys()])) {
        const row = document.createElement('div');
        row.className = 'settings-setting-row';
        const label = document.createElement('label');
        label.className = 'toggle-row';
        const input = document.createElement('input');
        input.type = 'checkbox'; input.value = String(id);
        input.checked = tagsMode.value === 'all' || selected.has(id);
        input.disabled = tagsMode.value === 'all';
        const name = document.createElement('span');
        name.textContent = tags.has(id) ? `${tags.get(id)} (#${id})` : `#${id}`;
        label.append(input, name);
        row.append(label);
        input.addEventListener('change', () => input.checked ? selected.add(id) : selected.delete(id), options);
        list.append(row);
      }
    }
    async function loadTags() {
      if (loading || !current()) return;
      loading = true; more.disabled = true; error.replaceChildren();
      try {
        const result = await api.get(`${ROOT}/live-settings/${account.id}/tags?page=${page + 1}`, options);
        if (!current()) return;
        page++;
        for (const tag of result.data) tags.set(tag.id, tag.name);
        more.hidden = !result.meta.has_more;
        drawTags();
      } catch (err) { if (current()) error.replaceChildren(createInlineError(message(err))); }
      finally { loading = false; if (current()) more.disabled = false; }
    }
    const displayInputs = /** @type {HTMLInputElement[]} */ ([...form.querySelectorAll('[data-display-fields] input')]);
    for (const input of displayInputs) bindInstantSwitch(input, {
      savedMessage: text('saved'),
      save: async () => {
        displayInputs.forEach((field) => { field.disabled = true; });
        error.replaceChildren();
        try {
          const result = await api.put(`${ROOT}/live-settings/${account.id}`, {
            token_mode: account.token_mode, allowed_tag_ids: account.allowed_tag_ids,
            display_fields: displayInputs.filter((field) => field.checked).map((field) => field.value),
            expected_revision: account.revision,
          });
          if (current()) Object.assign(account, result.data);
        } catch (err) {
          if (current()) error.replaceChildren(createInlineError(message(err)));
          throw err;
        } finally { if (current()) displayInputs.forEach((field) => { field.disabled = false; }); }
      },
    });
    tagsMode.addEventListener('change', () => {
      drawTags();
      if (!page) loadTags();
    }, options);
    more.addEventListener('click', () => loadTags(), options);
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      if (!current() || displayInputs.some((input) => input.disabled)) return;
      const submit = /** @type {HTMLButtonElement} */ (paperlessControl(form, '[type="submit"]'));
      if (submit.disabled) return;
      submit.disabled = true; displayInputs.forEach((input) => { input.disabled = true; }); error.replaceChildren();
      try {
        const result = await api.put(`${ROOT}/live-settings/${account.id}`, { token_mode: mode.value,
          display_fields: [...form.querySelectorAll('[data-display-fields] input:checked')].map((input) => /** @type {HTMLInputElement} */ (input).value),
          allowed_tag_ids: tagsMode.value === 'all' ? null : [...selected], expected_revision: account.revision });
        if (!current()) return;
        Object.assign(account, result.data);
        updateOwn();
        window.yuvomi?.showToast(text('saved'), 'success');
      } catch (err) { if (current()) error.replaceChildren(createInlineError(message(err))); }
      finally { if (current()) { submit.disabled = false; displayInputs.forEach((input) => { input.disabled = false; }); } }
    }, options);
    section.append(form);
    drawTags();
    // Start loading after the account section has been attached by render().
    section.loadInitialTags = () => loadTags();
  } else {
    const hint = document.createElement('p');
    hint.className = 'form-hint';
    hint.textContent = text(account.token_mode === 'shared' ? 'sharedHint' : 'personalHint');
    section.append(hint);
  }
  section.append(own);
  updateOwn();
  return section;
}

/** @param {HTMLElement} container @param {{signal?: AbortSignal}} [options] */
export async function render(container, { signal } = {}) {
  container.replaceChildren();
  container.insertAdjacentHTML('beforeend', `<section class="settings-section">
    <h2 class="settings-section__title">${esc(text('title'))}</h2>
    <p class="settings-card-description">${esc(text('description'))}</p>
    <div data-live-accounts></div></section>`);
  const host = /** @type {HTMLElement} */ (paperlessControl(container, '[data-live-accounts]'));
  try {
    const result = await api.get(`${ROOT}/live-settings`, { signal });
    if (signal?.aborted || !container.isConnected) return;
    if (!result.data.length) {
      const empty = document.createElement('p'); empty.className = 'form-hint'; empty.textContent = text('noAccounts');
      host.append(empty);
    }
    for (const account of result.data) {
      const section = buildAccount(account, { canManage: result.meta.can_manage, signal });
      host.append(section);
      section.loadInitialTags?.();
    }
  } catch (err) {
    if (!signal?.aborted && container.isConnected) host.replaceChildren(createRetryState({
      message: message(err), onRetry: () => render(container, { signal }),
    }));
  }
}
