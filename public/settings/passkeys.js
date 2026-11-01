import { api } from '/api.js';
import { t } from '/i18n.js';
import { dateText } from '/utils/date-format.js';
import { esc, REQUIRED_MARK } from '/utils/html.js';
import { openModal, closeModal, captureModalContext, captureOpenContext, isModalContextCurrent, confirmModal, constraintErrors, reportFieldErrors } from '/components/modal.js';
import { settingRowHtml } from '/settings/components.js';
import { createPasskey, usePasskey, passkeyErrorText, passkeysSupported } from '/utils/passkeys.js';

async function reauthenticate(state) {
  return new Promise(resolve => {
    let finished = false;
    const settle = value => { if (!finished) { finished = true; resolve(value); } };
    openModal({
      title: t('passkeys.reauthTitle'), size: 'sm', dirtyGuard: false,
      onClose: () => settle(false),
      content: `<p class="form-hint">${esc(t('passkeys.reauthLead'))}</p>
        <form id="passkey-reauth-form" novalidate>
          <div class="form-group form-field">
            <label class="form-label" for="passkey-reauth-password">${esc(t('login.passwordLabel'))}${REQUIRED_MARK}</label>
            <input class="form-input" id="passkey-reauth-password" type="password" autocomplete="current-password" maxlength="1024" required>
          </div>
          ${state.second_factor_required ? `<div class="form-group form-field">
            <label class="form-label" for="passkey-reauth-code">${esc(t('settings.twoFactorCodeOrRecoveryLabel'))}${REQUIRED_MARK}</label>
            <input class="form-input" id="passkey-reauth-code" type="text" autocomplete="one-time-code" maxlength="128" required>
          </div>` : ''}
          <p id="passkey-reauth-status" class="form-hint" role="status" aria-live="polite"></p>
          <div class="modal-panel__footer">
            <button type="button" class="btn btn--secondary" data-action="close-modal">${esc(t('common.cancel'))}</button>
            ${state.passkeys.length && passkeysSupported() ? `<button type="button" class="btn btn--secondary" id="passkey-reauth-use">${esc(t('passkeys.confirmWithPasskey'))}</button>` : ''}
            <button type="submit" class="btn btn--primary">${esc(t('common.confirm'))}</button>
          </div>
        </form>`,
      onSave: panel => {
        const context = captureModalContext();
        const form = panel.querySelector('#passkey-reauth-form');
        const password = panel.querySelector('#passkey-reauth-password');
        const status = panel.querySelector('#passkey-reauth-status');
        const buttons = panel.querySelectorAll('button:not([data-action="close-modal"])');
        let busy = false;
        const verify = async method => {
          if (busy || finished) return;
          password.required = method === 'password';
          const invalid = reportFieldErrors(constraintErrors(form));
          password.required = true;
          if (invalid) return;
          busy = true;
          const proof = { method, code: panel.querySelector('#passkey-reauth-code')?.value.trim() };
          for (const button of buttons) button.disabled = true;
          status.textContent = t('login.twoFactorChecking');
          try {
            if (method === 'passkey') {
              const { data: options } = await api.post('/auth/passkeys/reauth/options', {});
              if (finished) return;
              proof.credential = await usePasskey(options);
              if (finished) return;
            } else proof.password = password.value;
            await api.post('/auth/passkeys/reauth/verify', proof);
            if (finished) return;
            settle(true);
            closeModal({ force: true, context });
          } catch (error) {
            if (!finished) status.textContent = error?.data?.reason === 'passkey_failed'
              ? t('passkeys.reauthFailed') : passkeyErrorText(error);
          } finally {
            busy = false;
            password.value = '';
            for (const button of buttons) button.disabled = false;
          }
        };
        form.addEventListener('submit', event => { event.preventDefault(); void verify('password'); });
        panel.querySelector('#passkey-reauth-use')?.addEventListener('click', () => { void verify('passkey'); });
      },
    });
  });
}

async function withRecentAuthentication(action) {
  const context = captureOpenContext();
  try { return await action(); }
  catch (error) {
    if (error?.data?.reason !== 'passkey_reauth_required') throw error;
    const { data: state } = await api.get('/auth/passkeys');
    if (!isModalContextCurrent(context)) throw Object.assign(new Error(), { name: 'AbortError' });
    if (!state?.enrollment_allowed) throw error;
    if (!await reauthenticate(state)) throw Object.assign(new Error(), { name: 'AbortError' });
    return action();
  }
}

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
      const { data: options } = await withRecentAuthentication(() => api.post('/auth/passkeys/register/options', {}));
      const credential = await createPasskey(options);
      await withRecentAuthentication(() => api.post('/auth/passkeys/register/verify', { credential, name }));
      await renderPasskeyCard(container);
      container.querySelector('#passkey-status').textContent = t('passkeys.added');
    } catch (error) { status.textContent = passkeyErrorText(error); }
    finally { button.disabled = false; }
  });
  for (const button of container.querySelectorAll('[data-remove-passkey]')) {
    button.addEventListener('click', async () => {
      if (!await confirmModal({ title: t('passkeys.remove'), message: t('passkeys.removeConfirm') })) return;
      button.disabled = true;
      try { await withRecentAuthentication(() => api.delete(`/auth/passkeys/${button.dataset.removePasskey}`)); await renderPasskeyCard(container); }
      catch (error) { status.textContent = passkeyErrorText(error); button.disabled = false; }
    });
  }
}
