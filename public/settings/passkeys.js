import { api } from '/api.js';
import { t } from '/i18n.js';
import { dateText } from '/utils/date-format.js';
import { esc, REQUIRED_MARK } from '/utils/html.js';
import { confirmModal, constraintErrors, reportFieldErrors } from '/components/modal.js';
import { settingRowHtml } from '/settings/components.js';
import { createPasskey, passkeyErrorText, passkeysSupported } from '/utils/passkeys.js';

export async function renderPasskeyCard(container) {
  let state;
  try { state = (await api.get('/auth/passkeys'))?.data; } catch { return; }
  if (!state) return;
  const supported = passkeysSupported();
  const canAdd = supported && state.enabled && state.enrollment_allowed;
  container.replaceChildren();
  container.insertAdjacentHTML('beforeend', `
    <div class="settings-card">
      <h3 class="settings-card__title">${esc(t('passkeys.title'))}</h3>
      <p class="form-hint">${esc(t('passkeys.hint'))}</p>
      ${!state.enabled ? `<p class="form-hint">${esc(t('passkeys.needsHttps'))}</p>` : ''}
      ${!supported ? `<p class="form-hint">${esc(t('passkeys.unsupported'))}</p>` : ''}
      ${!state.enrollment_allowed ? `<p class="form-hint">${esc(t('passkeys.policy'))}</p>` : ''}
      <div class="row-carrier settings-group" ${state.passkeys.length ? '' : 'hidden'}>
        ${state.passkeys.map(key => settingRowHtml({
          label: key.name,
          description: key.last_used_at ? t('passkeys.used', { date: dateText(key.last_used_at) }) : t('passkeys.unused'),
          control: `<button type="button" class="btn btn--danger-outline" data-remove-passkey="${key.id}" aria-label="${esc(t('passkeys.removeNamed', { name: key.name }))}">${esc(t('passkeys.remove'))}</button>`,
        })).join('')}
      </div>
      ${!state.passkeys.length ? `<p class="form-hint">${esc(t('passkeys.empty'))}</p>` : ''}
      ${canAdd ? `<form id="passkey-add-form" class="settings-form" novalidate>
        <div class="form-group form-field">
          <label class="form-label" for="passkey-name">${esc(t('passkeys.name'))}${REQUIRED_MARK}</label>
          <input class="form-input" id="passkey-name" type="text" maxlength="80" required autocomplete="off">
        </div>
        <div class="settings-form-actions"><button type="submit" class="btn btn--primary">${esc(t('passkeys.add'))}</button></div>
      </form>` : ''}
      <p id="passkey-status" class="form-hint" role="status" aria-live="polite"></p>
    </div>`);
  const status = container.querySelector('#passkey-status');
  container.querySelector('#passkey-add-form')?.addEventListener('submit', async event => {
    event.preventDefault();
    const form = event.currentTarget;
    if (reportFieldErrors(constraintErrors(form))) return;
    const button = form.querySelector('button');
    const name = form.querySelector('input').value.trim();
    if (!name) return;
    button.disabled = true;
    status.textContent = t('passkeys.waiting');
    try {
      const { data: options } = await api.post('/auth/passkeys/register/options', {});
      const credential = await createPasskey(options);
      await api.post('/auth/passkeys/register/verify', { credential, name });
      await renderPasskeyCard(container);
      container.querySelector('#passkey-status').textContent = t('passkeys.added');
    } catch (error) { status.textContent = passkeyErrorText(error); }
    finally { button.disabled = false; }
  });
  for (const button of container.querySelectorAll('[data-remove-passkey]')) {
    button.addEventListener('click', async () => {
      if (!await confirmModal({ title: t('passkeys.remove'), message: t('passkeys.removeConfirm') })) return;
      button.disabled = true;
      try { await api.delete(`/auth/passkeys/${button.dataset.removePasskey}`); await renderPasskeyCard(container); }
      catch (error) { status.textContent = passkeyErrorText(error); button.disabled = false; }
    });
  }
}
