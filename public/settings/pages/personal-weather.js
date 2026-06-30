import { api } from '/api.js';
import { t } from '/i18n.js';
import { esc } from '/utils/html.js';

function isConnected(control, container) {
  return Boolean(control?.isConnected && container?.isConnected);
}

function hasOwnLocation(wu) {
  return Boolean(wu && (wu.lat !== null || wu.lon !== null));
}

function renderPage(container, prefs) {
  const wu = prefs.weather_user ?? { lat: null, lon: null, city: null, units: null, auto_locate: null };
  const providerIsOpenMeteo = prefs.weather_provider === 'open-meteo'
    || (!prefs.weather_provider && hasOwnLocation(wu));
  const own = hasOwnLocation(wu);
  container.replaceChildren();
  container.insertAdjacentHTML('beforeend', `
    <section class="settings-section">
      <h2 class="settings-section__title">${t('settings.personalWeatherTitle')}</h2>
      <div class="settings-card">
        <p class="settings-card-description">${t('settings.personalWeatherDescription')}</p>
        <div class="settings-sync-info">
          <span class="settings-sync-info__status${own ? ' settings-sync-info__status--connected' : ''}">
            ${own ? t('settings.personalWeatherSourceUser') : t('settings.personalWeatherSourceHousehold')}
          </span>
        </div>

        <form class="settings-form settings-form--compact" id="pweather-form" novalidate autocomplete="off">
          <div class="form-row">
            <div class="form-group">
              <label class="form-label" for="pweather-lat">${t('settings.weatherLatLabel')}</label>
              <input class="form-input" type="number" id="pweather-lat" step="any" min="-90" max="90"
                value="${esc(wu.lat ?? '')}" placeholder="${t('settings.weatherLatPlaceholder')}">
            </div>
            <div class="form-group">
              <label class="form-label" for="pweather-lon">${t('settings.weatherLonLabel')}</label>
              <input class="form-input" type="number" id="pweather-lon" step="any" min="-180" max="180"
                value="${esc(wu.lon ?? '')}" placeholder="${t('settings.weatherLonPlaceholder')}">
            </div>
          </div>
          <div class="settings-form-actions">
            <button type="button" class="btn btn--secondary btn--sm" id="pweather-locate-btn">
              <i data-lucide="map-pin" aria-hidden="true"></i>
              ${t('settings.weatherLocateBtn')}
            </button>
          </div>
          <div class="form-group">
            <label class="toggle-row">
              <input type="checkbox" id="pweather-auto-locate"${wu.auto_locate ? ' checked' : ''}${providerIsOpenMeteo ? '' : ' disabled'}>
              <span>${t('settings.weatherAutoLocateLabel')}</span>
            </label>
            <p class="form-hint">${t('settings.weatherAutoLocateHint')}</p>
          </div>
          <div class="form-group">
            <label class="form-label" for="pweather-city">${t('settings.weatherCityLabel')}</label>
            <input class="form-input" type="text" id="pweather-city" maxlength="100"
              value="${esc(wu.city ?? '')}" placeholder="${t('settings.weatherCityPlaceholder')}">
          </div>
          <div class="form-group">
            <label class="form-label" for="pweather-units">${t('settings.weatherUnitsLabel')}</label>
            <select class="form-input" id="pweather-units">
              <option value="metric"${wu.units === 'imperial' ? '' : ' selected'}>${t('settings.weatherUnitsMetric')}</option>
              <option value="imperial"${wu.units === 'imperial' ? ' selected' : ''}>${t('settings.weatherUnitsImperial')}</option>
            </select>
          </div>
          <div id="pweather-form-error" class="form-error" role="alert" hidden></div>
          <div class="settings-form-actions">
            <button type="submit" class="btn btn--primary">${t('settings.weatherSave')}</button>
            ${own ? `<button type="button" class="btn btn--secondary" id="pweather-reset-btn">${t('settings.personalWeatherUseHousehold')}</button>` : ''}
          </div>
        </form>
      </div>
    </section>
  `);
}

function requestLocation(container, locateButton) {
  if (!navigator.geolocation) {
    window.yuvomi?.showToast(t('settings.weatherLocateUnsupported'), 'warning');
    return;
  }
  locateButton.disabled = true;
  navigator.geolocation.getCurrentPosition(
    (position) => {
      if (!isConnected(locateButton, container)) return;
      container.querySelector('#pweather-lat').value = position.coords.latitude.toFixed(4);
      container.querySelector('#pweather-lon').value = position.coords.longitude.toFixed(4);
      locateButton.disabled = false;
      window.yuvomi?.showToast(t('settings.weatherLocateSuccess'), 'success');
    },
    (error) => {
      if (!isConnected(locateButton, container)) return;
      locateButton.disabled = false;
      window.yuvomi?.showToast(error.message || t('common.errorGeneric'), 'danger');
    },
    { enableHighAccuracy: true, timeout: 8000 },
  );
}

function readForm(container) {
  const lat = container.querySelector('#pweather-lat')?.value.trim() ?? '';
  const lon = container.querySelector('#pweather-lon')?.value.trim() ?? '';
  return {
    lat, lon,
    city: container.querySelector('#pweather-city')?.value.trim() ?? '',
    units: container.querySelector('#pweather-units')?.value ?? 'metric',
    auto_locate: container.querySelector('#pweather-auto-locate')?.checked ?? false,
  };
}

function validCoords(lat, lon) {
  const a = Number(lat), b = Number(lon);
  return lat !== '' && lon !== '' && Number.isFinite(a) && Number.isFinite(b)
    && a >= -90 && a <= 90 && b >= -180 && b <= 180;
}

function bindEvents(container, user) {
  const form = container.querySelector('#pweather-form');
  const errorElement = container.querySelector('#pweather-form-error');
  const locateButton = container.querySelector('#pweather-locate-btn');

  locateButton.addEventListener('click', () => requestLocation(container, locateButton));

  const autoLocate = container.querySelector('#pweather-auto-locate');
  autoLocate?.addEventListener('change', () => {
    if (autoLocate.checked) requestLocation(container, locateButton);
  });

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    errorElement.hidden = true;
    const v = readForm(container);
    if (!validCoords(v.lat, v.lon)) {
      errorElement.textContent = `${t('settings.weatherLatLabel')} / ${t('settings.weatherLonLabel')}`;
      errorElement.hidden = false;
      return;
    }
    try {
      await api.put('/preferences', {
        weather_user: {
          lat: v.lat, lon: v.lon,
          city: v.city || null,
          units: v.units,
          auto_locate: v.auto_locate,
        },
      });
      window.yuvomi?.showToast(t('settings.personalWeatherSaved'), 'success');
      await render(container, { user });
    } catch (error) {
      errorElement.textContent = error.message || t('common.errorGeneric');
      errorElement.hidden = false;
    }
  });

  container.querySelector('#pweather-reset-btn')?.addEventListener('click', async () => {
    try {
      await api.put('/preferences', {
        weather_user: { lat: null, lon: null, city: null, units: null, auto_locate: null },
      });
      window.yuvomi?.showToast(t('settings.personalWeatherReset'), 'success');
      await render(container, { user });
    } catch (error) {
      window.yuvomi?.showToast(error.message || t('common.errorGeneric'), 'danger');
    }
  });
}

export async function render(container, { user }) {
  const response = await api.get('/preferences');
  const prefs = response?.data ?? {};
  renderPage(container, prefs);
  bindEvents(container, user);
  window.lucide?.createIcons({ el: container });
}
