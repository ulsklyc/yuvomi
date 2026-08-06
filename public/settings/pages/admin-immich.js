import { api } from '/api.js';
import { t } from '/i18n.js';
import { esc } from '/utils/html.js';
import { createInlineError, createRetryState } from '/settings/components.js';

function toast(message, tone = 'default') {
  window.yuvomi?.showToast(message, tone);
}

function renderForm(container, cfg) {
  container.replaceChildren();
  container.insertAdjacentHTML('beforeend', `
    <section class="settings-section">
      <div class="settings-card">
        <p class="settings-card-description">${esc(t('settings.immichPurpose'))}</p>
        <form class="settings-form" id="immich-form" novalidate autocomplete="off">
          <div class="form-group">
            <label class="form-label" for="immich-url">${esc(t('settings.immichServerUrl'))}</label>
            <input class="form-input" id="immich-url" name="url" type="url"
              value="${esc(cfg.url || '')}" placeholder="https://photos.example.com" required />
            <p class="form-hint" data-env="url" hidden>${esc(t('settings.documentStorageEnvHint'))}</p>
          </div>
          <div class="form-group">
            <label class="form-label" for="immich-api-key">${esc(t('settings.immichApiKey'))}</label>
            <input class="form-input" id="immich-api-key" name="apiKey" type="password"
              autocomplete="new-password" placeholder="${cfg.apiKeySet ? '••••••••' : ''}" />
            <p class="form-hint">${esc(t('settings.immichApiKeyKeep'))}</p>
            <p class="form-hint" data-env="apiKey" hidden>${esc(t('settings.documentStorageEnvHint'))}</p>
          </div>
          <div class="form-group">
            <label class="form-label" for="immich-album">${esc(t('settings.immichAlbumId'))}</label>
            <input class="form-input" id="immich-album" name="albumId" type="text"
              value="${esc(cfg.albumId || '')}" />
            <p class="form-hint">${esc(t('settings.immichAlbumHint'))}</p>
            <p class="form-hint" data-env="albumId" hidden>${esc(t('settings.documentStorageEnvHint'))}</p>
          </div>
          <div id="immich-error"></div>
          <div class="settings-form-actions">
            <button class="btn btn--primary" type="submit">${esc(t('common.save'))}</button>
            <button class="btn btn--secondary" id="immich-test" type="button">${esc(t('settings.dmsTestBtn'))}</button>
            <button class="btn btn--secondary" id="immich-preview" type="button">${esc(t('settings.immichPreview'))}</button>
          </div>
        </form>
      </div>
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
