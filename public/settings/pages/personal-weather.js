import { t } from '/i18n.js';
import { getPreferences, savePreferences } from '/settings/preferences-cache.js';
import {
  PERSONAL_WEATHER_SCOPE as SCOPE,
  bindWeatherLocationEvents,
  hasValidWeatherCoords,
  readWeatherLocation,
  weatherLocationFieldsHtml,
} from '/settings/weather-location.js';

/**
 * Persönlicher Standort je Mitglied; überschreibt den Haushaltsstandort aus
 * `admin-weather`. Beide Blätter teilen sich das Standortformular aus
 * `/settings/weather-location.js`.
 */
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
          ${weatherLocationFieldsHtml({
            scope: SCOPE,
            values: wu,
            autoLocateDisabled: !providerIsOpenMeteo,
          })}
          <div id="pweather-form-error" class="form-error" role="alert" hidden></div>
          <div class="settings-form-actions">
            ${own ? `<button type="button" class="btn btn--secondary" id="pweather-reset-btn">${t('settings.personalWeatherUseHousehold')}</button>` : ''}
            <button type="submit" class="btn btn--primary">${t('settings.weatherSave')}</button>
          </div>
        </form>
      </div>
    </section>
  `);
}

function bindEvents(container, user) {
  const form = container.querySelector('#pweather-form');
  const errorElement = container.querySelector('#pweather-form-error');

  bindWeatherLocationEvents(container, SCOPE);

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    errorElement.hidden = true;
    const location = readWeatherLocation(container, SCOPE);
    if (!hasValidWeatherCoords(location.lat, location.lon)) {
      errorElement.textContent = t('settings.weatherCoordsInvalid');
      errorElement.hidden = false;
      return;
    }
    try {
      await savePreferences({
        weather_user: {
          lat: location.lat,
          lon: location.lon,
          city: location.city || null,
          units: location.units,
          auto_locate: location.auto_locate,
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
      await savePreferences({
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
  const prefs = await getPreferences();
  renderPage(container, prefs);
  bindEvents(container, user);
  window.lucide?.createIcons({ el: container });
}
