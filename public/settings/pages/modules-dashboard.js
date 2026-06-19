import { api } from '/api.js';
import { t } from '/i18n.js';
import { esc } from '/utils/html.js';

const APP_NAME_STORAGE_KEY = 'oikos-app-name';
const DEFAULT_APP_NAME = 'Yuvomi';

export function isConnectedWeatherControl(control, container) {
  return Boolean(control?.isConnected && container?.isConnected);
}

function safeStorageSet(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Storage can be unavailable in private or restricted browser contexts.
  }
}

function safeStorageRemove(key) {
  try {
    localStorage.removeItem(key);
  } catch {
    // Storage can be unavailable in private or restricted browser contexts.
  }
}

function providerLabel(provider) {
  if (provider === 'open-meteo') return t('settings.weatherProviderOpenMeteo');
  if (provider === 'openweathermap') return t('settings.weatherProviderOwm');
  return t('settings.weatherProviderNone');
}

function renderPage(container, preferences) {
  container.replaceChildren();
  container.insertAdjacentHTML('beforeend', `
    <section class="settings-section">
      <h2 class="settings-section__title">${t('settings.sectionWeather')}</h2>
      <div class="settings-card">
        <h3 class="settings-card__title">${t('settings.weatherTitle')}</h3>
        <p class="settings-card-description">${t('settings.weatherDescription')}</p>
        <div class="settings-sync-info">
          <span class="form-label">${t('settings.weatherActiveProvider')}</span>
          <span class="settings-sync-info__status${preferences.weather_provider === 'open-meteo' ? ' settings-sync-info__status--connected' : ''}">
            ${providerLabel(preferences.weather_provider)}
          </span>
        </div>

        <form class="settings-form settings-form--compact" id="weather-form" novalidate autocomplete="off">
          <div class="form-row">
            <div class="form-group">
              <label class="form-label" for="weather-lat">${t('settings.weatherLatLabel')}</label>
              <input class="form-input" type="number" id="weather-lat" step="any" min="-90" max="90"
                value="${esc(preferences.weather_lat ?? '')}"
                placeholder="${t('settings.weatherLatPlaceholder')}">
            </div>
            <div class="form-group">
              <label class="form-label" for="weather-lon">${t('settings.weatherLonLabel')}</label>
              <input class="form-input" type="number" id="weather-lon" step="any" min="-180" max="180"
                value="${esc(preferences.weather_lon ?? '')}"
                placeholder="${t('settings.weatherLonPlaceholder')}">
            </div>
          </div>
          <div class="settings-form-actions">
            <button type="button" class="btn btn--secondary btn--sm" id="weather-locate-btn">
              <i data-lucide="map-pin" aria-hidden="true"></i>
              ${t('settings.weatherLocateBtn')}
            </button>
          </div>
          <div class="form-group">
            <label class="toggle-row">
              <input type="checkbox" id="weather-auto-locate"${preferences.weather_auto_locate ? ' checked' : ''}>
              <span>${t('settings.weatherAutoLocateLabel')}</span>
            </label>
            <p class="form-hint">${t('settings.weatherAutoLocateHint')}</p>
          </div>
          <div class="form-group">
            <label class="form-label" for="weather-city">${t('settings.weatherCityLabel')}</label>
            <input class="form-input" type="text" id="weather-city" maxlength="100"
              value="${esc(preferences.weather_city ?? '')}"
              placeholder="${t('settings.weatherCityPlaceholder')}">
          </div>
          <div class="form-group">
            <label class="form-label" for="weather-units">${t('settings.weatherUnitsLabel')}</label>
            <select class="form-input" id="weather-units">
              <option value="metric"${preferences.weather_units === 'imperial' ? '' : ' selected'}>${t('settings.weatherUnitsMetric')}</option>
              <option value="imperial"${preferences.weather_units === 'imperial' ? ' selected' : ''}>${t('settings.weatherUnitsImperial')}</option>
            </select>
          </div>
          <p class="form-hint">${t('settings.weatherCoordHint')}</p>
          <p class="form-hint">${t('settings.weatherSwitchHint')}</p>
          <div id="weather-form-error" class="form-error" role="alert" hidden></div>
          <div class="settings-form-actions">
            <button type="submit" class="btn btn--primary">${t('settings.weatherSave')}</button>
            ${preferences.weather_provider === 'open-meteo' ? `
              <button type="button" class="btn btn--danger" id="weather-remove-btn">${t('settings.weatherRemove')}</button>
            ` : ''}
          </div>
        </form>
      </div>
    </section>

    <section class="settings-section">
      <h2 class="settings-section__title">${t('settings.sectionAppName')}</h2>
      <div class="settings-card">
        <h3 class="settings-card__title">${t('settings.appNameTitle')}</h3>
        <p class="form-hint">${t('settings.appNameHint')}</p>
        <form class="settings-form settings-form--compact" id="app-name-form" novalidate autocomplete="off">
          <div class="form-group">
            <label class="form-label" for="app-name-input">${t('settings.appNameLabel')}</label>
            <input class="form-input" type="text" id="app-name-input" maxlength="60"
              placeholder="${t('settings.appNamePlaceholder')}"
              value="${esc(preferences.app_name || DEFAULT_APP_NAME)}">
          </div>
          <div id="app-name-error" class="form-error" role="alert" hidden></div>
          <div class="settings-form-actions">
            <button type="submit" class="btn btn--primary">${t('common.save')}</button>
            <button type="button" class="btn btn--secondary" id="app-name-reset-btn">${t('common.reset')}</button>
          </div>
        </form>
      </div>
    </section>
  `);
}

function weatherPreferenceData(container) {
  return {
    weather_lat: container.querySelector('#weather-lat')?.value.trim() ?? '',
    weather_lon: container.querySelector('#weather-lon')?.value.trim() ?? '',
    weather_city: container.querySelector('#weather-city')?.value.trim() ?? '',
    weather_units: container.querySelector('#weather-units')?.value ?? 'metric',
    weather_provider: 'open-meteo',
    weather_auto_locate: container.querySelector('#weather-auto-locate')?.checked ?? false,
  };
}

function validateWeather(preferenceData) {
  const latitude = Number(preferenceData.weather_lat);
  const longitude = Number(preferenceData.weather_lon);
  return preferenceData.weather_lat !== ''
    && preferenceData.weather_lon !== ''
    && Number.isFinite(latitude)
    && Number.isFinite(longitude)
    && latitude >= -90
    && latitude <= 90
    && longitude >= -180
    && longitude <= 180;
}

function refreshBranding(appName) {
  if (appName) safeStorageSet(APP_NAME_STORAGE_KEY, appName);
  else safeStorageRemove(APP_NAME_STORAGE_KEY);
  window.dispatchEvent(new CustomEvent('app-name-changed', {
    detail: { appName: appName || DEFAULT_APP_NAME },
  }));
}

function requestLocation(container, locateButton) {
  if (!navigator.geolocation) {
    window.oikos?.showToast(t('settings.weatherLocateUnsupported'), 'warning');
    return;
  }

  locateButton.disabled = true;
  navigator.geolocation.getCurrentPosition(
    (position) => {
      if (!isConnectedWeatherControl(locateButton, container)) return;

      const latitudeInput = container.querySelector('#weather-lat');
      const longitudeInput = container.querySelector('#weather-lon');
      latitudeInput.value = position.coords.latitude.toFixed(4);
      longitudeInput.value = position.coords.longitude.toFixed(4);
      locateButton.disabled = false;
      window.oikos?.showToast(t('settings.weatherLocateSuccess'), 'success');
    },
    (error) => {
      if (!isConnectedWeatherControl(locateButton, container)) return;

      locateButton.disabled = false;
      window.oikos?.showToast(error.message || t('common.errorGeneric'), 'danger');
    },
    { enableHighAccuracy: true, timeout: 8000 },
  );
}

function bindWeatherEvents(container, user) {
  const form = container.querySelector('#weather-form');
  const errorElement = container.querySelector('#weather-form-error');

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    errorElement.hidden = true;
    const preferenceData = weatherPreferenceData(container);
    if (!validateWeather(preferenceData)) {
      errorElement.textContent = `${t('settings.weatherLatLabel')} / ${t('settings.weatherLonLabel')}`;
      errorElement.hidden = false;
      return;
    }

    try {
      await api.put('/preferences', {
        weather_lat: preferenceData.weather_lat,
        weather_lon: preferenceData.weather_lon,
        weather_city: preferenceData.weather_city,
        weather_units: preferenceData.weather_units,
        weather_provider: preferenceData.weather_provider,
        weather_auto_locate: preferenceData.weather_auto_locate,
      });
      window.oikos?.showToast(t('settings.weatherSaved'), 'success');
      await render(container, { user });
    } catch (error) {
      errorElement.textContent = error.message || t('common.errorGeneric');
      errorElement.hidden = false;
    }
  });

  container.querySelector('#weather-remove-btn')?.addEventListener('click', async () => {
    try {
      await api.put('/preferences', { weather_provider: null });
      window.oikos?.showToast(t('settings.weatherRemoved'), 'success');
      await render(container, { user });
    } catch (error) {
      window.oikos?.showToast(error.message || t('common.errorGeneric'), 'danger');
    }
  });

  const locateButton = container.querySelector('#weather-locate-btn');
  locateButton.addEventListener('click', () => requestLocation(container, locateButton));

  const autoLocateCheckbox = container.querySelector('#weather-auto-locate');
  autoLocateCheckbox?.addEventListener('change', () => {
    if (autoLocateCheckbox.checked) requestLocation(container, locateButton);
  });
}

function bindAppNameEvents(container) {
  const form = container.querySelector('#app-name-form');
  const input = container.querySelector('#app-name-input');
  const errorElement = container.querySelector('#app-name-error');

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    errorElement.hidden = true;
    const value = input.value.trim();
    try {
      await api.put('/preferences', { app_name: value });
      input.value = value || DEFAULT_APP_NAME;
      refreshBranding(value);
      window.oikos?.showToast(t('settings.appNameSavedToast'), 'success');
    } catch (error) {
      errorElement.textContent = error.message || t('common.errorGeneric');
      errorElement.hidden = false;
    }
  });

  container.querySelector('#app-name-reset-btn').addEventListener('click', async () => {
    errorElement.hidden = true;
    try {
      await api.put('/preferences', { app_name: '' });
      input.value = DEFAULT_APP_NAME;
      refreshBranding('');
      window.oikos?.showToast(t('settings.appNameSavedToast'), 'success');
    } catch (error) {
      errorElement.textContent = error.message || t('common.errorGeneric');
      errorElement.hidden = false;
    }
  });
}

export async function render(container, { user }) {
  const response = await api.get('/preferences');
  const preferences = response?.data ?? {};
  if (preferences.app_name) safeStorageSet(APP_NAME_STORAGE_KEY, preferences.app_name);
  renderPage(container, preferences);
  bindWeatherEvents(container, user);
  bindAppNameEvents(container);
  window.lucide?.createIcons({ el: container });
}
