import { t } from '/i18n.js';
import { esc } from '/utils/html.js';
import { settingRowHtml, settingSwitchRowHtml } from '/settings/components.js';

/**
 * Standortformular für das Wetter-Widget - einmal für den Haushalt
 * (`admin-weather`), einmal je Mitglied (`personal-weather`). Beide Blätter
 * rendern dieselben fünf Felder mit denselben i18n-Keys und hatten
 * `requestLocation` samt Koordinatenvalidierung doppelt implementiert
 * (Critique 2026-07-27).
 *
 * `scope` ist zugleich das id-Präfix der Felder, damit die bestehenden
 * DOM-Verträge (`#weather-lat`, `#pweather-lat`, ...) unverändert bleiben.
 */
export const HOUSEHOLD_WEATHER_SCOPE = 'weather';
export const PERSONAL_WEATHER_SCOPE = 'pweather';

export function isConnectedWeatherControl(control, container) {
  return Boolean(control?.isConnected && container?.isConnected);
}

export function hasValidWeatherCoords(lat, lon) {
  const latitude = Number(lat);
  const longitude = Number(lon);
  return lat !== ''
    && lon !== ''
    && Number.isFinite(latitude)
    && Number.isFinite(longitude)
    && latitude >= -90
    && latitude <= 90
    && longitude >= -180
    && longitude <= 180;
}

export function weatherLocationFieldsHtml({ scope, values = {}, autoLocateDisabled = false }) {
  const units = values.units === 'imperial' ? 'imperial' : 'metric';
  // EIN FORMULAR-DIALEKT (R19, Einstellungen B7): Breite, Laenge, Ort und
  // Einheiten als Zeilen der Gruppe, der Auto-Standort als Schalterzeile; die
  // Ortung per Knopf steht unter der Gruppe. Vorher ein zweispaltiges
  // `.form-row` (ein Name, den seit R18 die Formularzeile traegt) mit Feldern
  // unter ihren Etiketten.
  return `
    <div class="row-carrier settings-group">
      ${settingRowHtml({
        label: t('settings.weatherLatLabel'), labelFor: `${scope}-lat`,
        control: `<input class="form-input" type="number" id="${scope}-lat" step="any" min="-90" max="90"
          value="${esc(values.lat ?? '')}" placeholder="${t('settings.weatherLatPlaceholder')}">`,
      })}
      ${settingRowHtml({
        label: t('settings.weatherLonLabel'), labelFor: `${scope}-lon`,
        control: `<input class="form-input" type="number" id="${scope}-lon" step="any" min="-180" max="180"
          value="${esc(values.lon ?? '')}" placeholder="${t('settings.weatherLonPlaceholder')}">`,
      })}
      ${settingSwitchRowHtml({
        label: t('settings.weatherAutoLocateLabel'),
        checked: !!values.auto_locate,
        disabled: autoLocateDisabled,
        description: t('settings.weatherAutoLocateHint'),
        descriptionId: `${scope}-auto-locate-hint`,
        attrs: { id: `${scope}-auto-locate` },
      })}
      ${settingRowHtml({
        label: t('settings.weatherCityLabel'), labelFor: `${scope}-city`,
        control: `<input class="form-input" type="text" id="${scope}-city" maxlength="100"
          value="${esc(values.city ?? '')}" placeholder="${t('settings.weatherCityPlaceholder')}">`,
      })}
      ${settingRowHtml({
        label: t('settings.weatherUnitsLabel'), labelFor: `${scope}-units`,
        control: `<select class="form-input" id="${scope}-units">
          <option value="metric"${units === 'metric' ? ' selected' : ''}>${t('settings.weatherUnitsMetric')}</option>
          <option value="imperial"${units === 'imperial' ? ' selected' : ''}>${t('settings.weatherUnitsImperial')}</option>
        </select>`,
      })}
    </div>
    <div class="settings-form-actions">
      <button type="button" class="btn btn--secondary btn--sm" id="${scope}-locate-btn">
        <i data-lucide="map-pin" aria-hidden="true"></i>
        ${t('settings.weatherLocateBtn')}
      </button>
    </div>
  `;
}

export function readWeatherLocation(container, scope) {
  return {
    lat: container.querySelector(`#${scope}-lat`)?.value.trim() ?? '',
    lon: container.querySelector(`#${scope}-lon`)?.value.trim() ?? '',
    city: container.querySelector(`#${scope}-city`)?.value.trim() ?? '',
    units: container.querySelector(`#${scope}-units`)?.value ?? 'metric',
    auto_locate: container.querySelector(`#${scope}-auto-locate`)?.checked ?? false,
  };
}

function requestLocation(container, scope, locateButton) {
  if (!navigator.geolocation) {
    window.yuvomi?.showToast(t('settings.weatherLocateUnsupported'), 'warning');
    return;
  }

  locateButton.disabled = true;
  navigator.geolocation.getCurrentPosition(
    (position) => {
      // Der Callback kann nach einem Blattwechsel eintreffen; dann gehört das
      // Formular nicht mehr zum Dokument und darf nicht mehr beschrieben werden.
      if (!isConnectedWeatherControl(locateButton, container)) return;

      container.querySelector(`#${scope}-lat`).value = position.coords.latitude.toFixed(4);
      container.querySelector(`#${scope}-lon`).value = position.coords.longitude.toFixed(4);
      locateButton.disabled = false;
      window.yuvomi?.showToast(t('settings.weatherLocateSuccess'), 'success');
    },
    (error) => {
      if (!isConnectedWeatherControl(locateButton, container)) return;

      locateButton.disabled = false;
      window.yuvomi?.showToast(error.message || t('common.errorGeneric'), 'danger');
    },
    { enableHighAccuracy: true, timeout: 8000 },
  );
}

export function bindWeatherLocationEvents(container, scope) {
  const locateButton = container.querySelector(`#${scope}-locate-btn`);
  locateButton?.addEventListener('click', () => requestLocation(container, scope, locateButton));

  const autoLocate = container.querySelector(`#${scope}-auto-locate`);
  autoLocate?.addEventListener('change', () => {
    if (autoLocate.checked && locateButton) requestLocation(container, scope, locateButton);
  });
}
