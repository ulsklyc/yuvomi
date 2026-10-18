import { api } from '/api.js';
import { t } from '/i18n.js';
import { esc } from '/utils/html.js';
import { createInlineError, createRetryState, settingRowHtml } from '/settings/components.js';

function toast(message, tone = 'default') {
  window.yuvomi?.showToast(message, tone);
}

function renderForm(container, cfg) {
  container.replaceChildren();
  container.insertAdjacentHTML('beforeend', `
    <section class="settings-section">
      ${/* EIN FORMULAR-DIALEKT (R19, Einstellungen B7), wie SMTP: drei Felder
           als Zeilen der Gruppe statt unter ihren Etiketten in einer Karte;
           der Zweck steht als Fuss der Gruppe. */ ''}
      <form class="settings-form" id="immich-form" novalidate autocomplete="off">
        <div class="row-carrier settings-group">
          ${settingRowHtml({
            label: t('settings.immichServerUrl'), labelFor: 'immich-url',
            control: `<input class="form-input" id="immich-url" name="url" type="url"
              value="${esc(cfg.url || '')}" placeholder="https://photos.example.com" required />`,
            extra: `<p class="form-hint" data-env="url" hidden>${esc(t('settings.documentStorageEnvHint'))}</p>`,
          })}
          ${settingRowHtml({
            label: t('settings.immichApiKey'), labelFor: 'immich-api-key',
            description: t('settings.immichApiKeyKeep'), descriptionId: 'immich-api-key-hint',
            control: `<input class="form-input" id="immich-api-key" name="apiKey" type="password"
              autocomplete="new-password" aria-describedby="immich-api-key-hint" placeholder="${cfg.apiKeySet ? '••••••••' : ''}" />`,
            extra: `<p class="form-hint" data-env="apiKey" hidden>${esc(t('settings.documentStorageEnvHint'))}</p>`,
          })}
          ${settingRowHtml({
            label: t('settings.immichAlbumId'), labelFor: 'immich-album',
            description: t('settings.immichAlbumHint'), descriptionId: 'immich-album-hint',
            control: `<input class="form-input" id="immich-album" name="albumId" type="text"
              aria-describedby="immich-album-hint" value="${esc(cfg.albumId || '')}" />`,
            extra: `<p class="form-hint" data-env="albumId" hidden>${esc(t('settings.documentStorageEnvHint'))}</p>`,
          })}
        </div>
        <p class="form-hint settings-group__footer">${esc(t('settings.immichPurpose'))}</p>
        <div id="immich-error"></div>
        <div class="settings-form-actions">
          <button class="btn btn--secondary" id="immich-test" type="button">${esc(t('settings.dmsTestBtn'))}</button>
          <button class="btn btn--secondary" id="immich-preview" type="button">${esc(t('settings.immichPreview'))}</button>
          <button class="btn btn--primary" type="submit">${esc(t('common.save'))}</button>
        </div>
      </form>
    </section>
  `);

  const form = container.querySelector('#immich-form');
  const errorHost = container.querySelector('#immich-error');
  const env = cfg.envControlled || {};
  for (const field of ['url', 'apiKey', 'albumId']) {
    form.elements[field].disabled = env[field] === true;
    container.querySelector(`[data-env="${field}"]`).hidden = env[field] !== true;
  }

  const collect = () => ({
    ...(env.url ? {} : { url: form.url.value.trim() }),
    ...(env.albumId ? {} : { albumId: form.albumId.value.trim() }),
    ...(env.apiKey || !form.apiKey.value ? {} : { apiKey: form.apiKey.value }),
  });

  const save = async () => {
    errorHost.replaceChildren();
    await api.put('/screensaver/config', collect());
    form.apiKey.value = '';
  };

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const button = form.querySelector('[type="submit"]');
    button.disabled = true;
    try {
      await save();
      toast(t('settings.immichSaved'), 'success');
    } catch (error) {
      errorHost.replaceChildren(createInlineError(error.message || t('common.errorGeneric')));
    } finally {
      button.disabled = false;
    }
  });

  container.querySelector('#immich-test').addEventListener('click', async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    errorHost.replaceChildren();
    try {
      await save();
      await api.post('/screensaver/test', {});
      toast(t('settings.immichTestOk'), 'success');
    } catch (error) {
      errorHost.replaceChildren(createInlineError(error.message || t('common.errorGeneric')));
    } finally {
      button.disabled = false;
    }
  });

  container.querySelector('#immich-preview').addEventListener('click', async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    errorHost.replaceChildren();
    try {
      await save();
      const { preview } = await import('/components/photo-screensaver.js');
      if (!await preview()) throw new Error(t('settings.immichPreviewUnavailable'));
    } catch (error) {
      errorHost.replaceChildren(createInlineError(error.message || t('common.errorGeneric')));
    } finally {
      button.disabled = false;
    }
  });
}

export async function render(container) {
  try {
    const response = await api.get('/screensaver/config');
    renderForm(container, response.data || {});
  } catch (error) {
    container.replaceChildren(createRetryState({
      message: error.message || t('common.errorGeneric'),
      onRetry: () => render(container),
    }));
  }
}
