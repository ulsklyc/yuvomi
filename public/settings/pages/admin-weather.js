import { t } from '/i18n.js';
import { esc } from '/utils/html.js';
import { getPreferences, savePreferences } from '/settings/preferences-cache.js';
import {
  HOUSEHOLD_WEATHER_SCOPE as SCOPE,
  bindWeatherLocationEvents,
  hasValidWeatherCoords,
  readWeatherLocation,
  weatherLocationFieldsHtml,
} from '/settings/weather-location.js';

/**
 * Haushalts-Standardstandort für das Wetter-Widget. Lag bis zum IA-Umbau in
 * `modules-dashboard` neben dem Anwendungsnamen, unter dem Label "Übersicht" -
 * ein Blatt, das keine einzige Widget-Einstellung trug (Critique 2026-07-27).
 * Das Gegenstück je Mitglied ist `personal-weather`; beide teilen sich das
 * Standortformular aus `/settings/weather-location.js`.
 */
function providerLabel(weatherSource) {
  const { source, provider } = weatherSource;
  if (source === 'env' && provider === 'open-meteo') return t('settings.weatherProviderOpenMeteoEnv');
  if (provider === 'open-meteo') return t('settings.weatherProviderOpenMeteo');
  if (provider === 'openweathermap') return t('settings.weatherProviderOwm');
  return t('settings.weatherProviderNone');
}

// Welche Konfiguration gilt, entscheidet der Server (`weather_source`, Regel in
// server/services/weather-source.js) - hier wird sie nur angezeigt. Vorher las
// die Seite nur `weather_provider` und sagte "Nicht konfiguriert", waehrend das
// Dashboard Wetter aus der `.env` zeigte (Web-Installer).
export function weatherSourceOf(preferences) {
  return preferences?.weather_source ?? { source: 'none', provider: null };
}

// Nur ein hier gespeicherter Open-Meteo-Standort laesst sich hier entfernen.
// Dazu zaehlen auch Koordinaten ohne Anbieter, die ein frueheres "Entfernen"
// liegen liess - der Proxy nimmt sie, also muss man sie loswerden koennen.
export function canRemoveStoredWeather(weatherSource) {
  return weatherSource.source === 'db' && weatherSource.provider === 'open-meteo';
}

/**
 * Statuszeile plus - bei Wetter aus der Serverkonfiguration - deren Standort
 * schreibgeschuetzt und der Weg, sie abzuschalten. Anders als bei E-Mail und
 * WebDAV gewinnt hier die Datenbank: das Formular darunter bleibt offen, und
 * wer speichert, uebersteuert die `.env`.
 */
export function weatherSourceHtml(weatherSource) {
  const connected = weatherSource.provider === 'open-meteo';
  const status = `
        <div class="settings-sync-info">
          <span class="form-label">${t('settings.weatherActiveProvider')}</span>
          <span class="settings-sync-info__status${connected ? ' settings-sync-info__status--connected' : ''}">
            ${providerLabel(weatherSource)}
          </span>
        </div>`;
  if (weatherSource.source !== 'env') return status;

  const { lat, lon, city, units, provider } = weatherSource;
  const coords = lat && lon ? `${lat}, ${lon}` : '';
  const location = city && coords ? `${city} (${coords})` : (city || coords);
  const vars = provider === 'openweathermap' ? 'OPENWEATHER_*' : 'WEATHER_*';
  return `${status}
        <div class="settings-sync-info">
          <span class="form-label">${t('settings.weatherEnvLocationLabel')}</span>
          <span class="settings-sync-info__status">${esc(location)}</span>
        </div>
        <div class="settings-sync-info">
          <span class="form-label">${t('settings.weatherUnitsLabel')}</span>
          <span class="settings-sync-info__status">${units === 'imperial' ? t('settings.weatherUnitsImperial') : t('settings.weatherUnitsMetric')}</span>
        </div>
        <p class="form-hint" id="weather-env-hint">${t('settings.weatherEnvHint', { vars })}</p>`;
}

function renderPage(container, preferences) {
  const weatherSource = weatherSourceOf(preferences);
  container.replaceChildren();
  container.insertAdjacentHTML('beforeend', `
    <section class="settings-section">
      <h2 class="settings-section__title">${t('settings.sectionWeather')}</h2>
      <div class="settings-card">
        <h3 class="settings-card__title">${t('settings.weatherTitle')}</h3>
        <p class="settings-card-description">${t('settings.weatherDescription')}</p>
        ${weatherSourceHtml(weatherSource)}

        <form class="settings-form settings-form--compact" id="weather-form" novalidate autocomplete="off">
          ${weatherLocationFieldsHtml({
            scope: SCOPE,
            values: {
              lat: preferences.weather_lat,
              lon: preferences.weather_lon,
              city: preferences.weather_city,
              units: preferences.weather_units,
              auto_locate: preferences.weather_auto_locate,
            },
          })}
          <p class="form-hint">${t('settings.weatherCoordHint')}</p>
          <p class="form-hint">${t('settings.weatherSwitchHint')}</p>
          <p class="form-hint">${t('settings.householdWeatherOverrideHint')}</p>
          <div id="weather-form-error" class="form-error" role="alert" hidden></div>
          <div class="settings-form-actions">
            ${canRemoveStoredWeather(weatherSource) ? `
              <button type="button" class="btn btn--danger" id="weather-remove-btn">${t('settings.weatherRemove')}</button>
            ` : ''}
            <button type="submit" class="btn btn--primary">${t('settings.weatherSave')}</button>
          </div>
        </form>
      </div>
    </section>
  `);
}

function bindWeatherEvents(container, user) {
  const form = container.querySelector('#weather-form');
  const errorElement = container.querySelector('#weather-form-error');

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
        weather_lat: location.lat,
        weather_lon: location.lon,
        weather_city: location.city,
        weather_units: location.units,
        weather_provider: 'open-meteo',
        weather_auto_locate: location.auto_locate,
      });
      window.yuvomi?.showToast(t('settings.weatherSaved'), 'success');
      await render(container, { user });
    } catch (error) {
      errorElement.textContent = error.message || t('common.errorGeneric');
      errorElement.hidden = false;
    }
  });

  container.querySelector('#weather-remove-btn')?.addEventListener('click', async () => {
    try {
      // Koordinaten mit loeschen: ohne Anbieter nimmt der Proxy sie sonst
      // weiter, und die `.env`-Werte kaemen nie wieder zum Zug.
      await savePreferences({ weather_provider: null, weather_lat: null, weather_lon: null, weather_city: '' });
      const next = weatherSourceOf(await getPreferences());
      window.yuvomi?.showToast(
        next.source === 'env' ? t('settings.weatherRemovedEnv') : t('settings.weatherRemoved'),
        'success',
      );
      await render(container, { user });
    } catch (error) {
      window.yuvomi?.showToast(error.message || t('common.errorGeneric'), 'danger');
    }
  });

  bindWeatherLocationEvents(container, SCOPE);
}

export async function render(container, { user }) {
  const preferences = await getPreferences();
  renderPage(container, preferences);
  bindWeatherEvents(container, user);
  window.lucide?.createIcons({ el: container });
}
