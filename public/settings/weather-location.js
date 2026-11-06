import { api } from '/api.js';
import { getLocale, t } from '/i18n.js';
import { esc } from '/utils/html.js';
import { isImeComposing } from '/utils/ux.js';
import { settingRowHtml, settingSwitchRowHtml } from '/settings/components.js';
import { clearFieldError, reportFieldError } from '/components/modal.js';

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

/** "Berlin (52.52, 13.41)" - der Ort, wie das Formular ihn gerade haelt. */
export function weatherPlaceText({ lat, lon, city } = {}) {
  if (!hasValidWeatherCoords(lat ?? '', lon ?? '')) return '';
  const coords = `${Number(lat).toFixed(2)}, ${Number(lon).toFixed(2)}`;
  return city ? `${city} (${coords})` : coords;
}

/**
 * Zweite Zeile eines Treffers: Region und Land, ohne Wiederholung des Namens.
 * Teilt sich ein Treffer Name, Region und Land mit einem anderen der Liste
 * ("Halle" zweimal in Flandern), steht der Kreis davor - sonst standen zwei
 * gleiche Zeilen untereinander.
 */
export function weatherPlaceMeta(place, places = []) {
  const key = (p) => [p?.name, p?.admin1, p?.country].join('|');
  const twin = places.some((other) => other !== place && key(other) === key(place));
  const parts = [twin ? place?.admin2 : null, place?.admin1, place?.country]
    .filter((part, i, all) => part && part !== place?.name && all.indexOf(part) === i);
  // Fehlt der Kreis oder heisst er bei beiden gleich, unterscheiden nur noch
  // die Koordinaten.
  const stillTwin = twin && places.some((other) => other !== place && key(other) === key(place)
    && (other?.admin2 ?? null) === (place?.admin2 ?? null));
  if (stillTwin && Number.isFinite(place?.latitude) && Number.isFinite(place?.longitude)) {
    parts.push(`${place.latitude.toFixed(2)}, ${place.longitude.toFixed(2)}`);
  }
  return parts.join(', ');
}

export function weatherLocationFieldsHtml({ scope, values = {}, autoLocateDisabled = false }) {
  const units = values.units === 'imperial' ? 'imperial' : 'metric';
  const current = weatherPlaceText(values);
  // ORTSSUCHE VOR KOORDINATEN (R20, Ulas 2026-10-17). Bis dahin verlangte das
  // Formular Breiten- und Laengengrad und schickte fuer beide zu
  // openstreetmap.org. Jetzt steht oben die Suche nach dem Ortsnamen
  // (Open-Meteo Geocoding ueber den Server, GET /weather/geocode); gesucht wird
  // erst auf "Suchen" bzw. Enter, nicht bei jedem Tastendruck. Die Koordinaten
  // bleiben als Rueckfall unter "Koordinaten von Hand" - wer einen Ort waehlt,
  // fuellt sie, und dort stehen sie weiter zum Nachsehen und Korrigieren.
  // Das Feld ist ein Formularfeld mit sichtbarem Etikett, kein Seitenfilter:
  // darum `type="text"` mit `enterkeyhint="search"` statt der Suchkapsel
  // (renderPageSearch filtert beim Tippen, hier fragt erst Enter den Server).
  //
  // EIN FORMULAR-DIALEKT (R19, Einstellungen B7): Zeilen der Gruppe, der
  // Auto-Standort als Schalterzeile, die Ortung per Knopf unter der Gruppe.
  const manualOpen = Boolean(current && !values.city);
  return `
    <div class="row-carrier settings-group">
      ${settingRowHtml({
        label: t('settings.weatherPlaceLabel'), labelFor: `${scope}-place`,
        description: t('settings.weatherPlaceHint'), descriptionId: `${scope}-place-hint`,
        stacked: true, field: true, className: 'weather-place',
        control: `
          <div class="weather-place__search">
            <input class="form-input" type="text" id="${scope}-place" maxlength="100"
              enterkeyhint="search" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false"
              aria-describedby="${scope}-place-hint ${scope}-place-current"
              placeholder="${esc(t('settings.weatherPlacePlaceholder'))}">
            <button type="button" class="btn btn--secondary" id="${scope}-place-btn">${esc(t('settings.weatherPlaceSearch'))}</button>
          </div>
          <p class="form-hint weather-place__current" id="${scope}-place-current">${esc(current
            ? t('settings.weatherPlaceCurrent', { place: current })
            : t('settings.weatherPlaceNone'))}</p>
          <ul class="weather-place__results" id="${scope}-place-results" aria-label="${esc(t('settings.weatherPlaceResultsLabel'))}" hidden></ul>
          <p class="weather-place__status sr-only" id="${scope}-place-status" role="status" aria-live="polite"></p>`,
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
    <section class="settings-disclosure weather-manual">
      <button type="button" class="settings-disclosure__trigger" id="${scope}-manual-trigger"
        aria-controls="${scope}-manual-panel" aria-expanded="${manualOpen}">
        ${esc(t('settings.weatherManualTitle'))}
        <i class="settings-disclosure__icon" data-lucide="chevron-down" aria-hidden="true"></i>
      </button>
      <div class="settings-disclosure__panel" id="${scope}-manual-panel" aria-labelledby="${scope}-manual-trigger"${manualOpen ? '' : ' hidden'}>
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
          ${settingRowHtml({
            label: t('settings.weatherCityLabel'), labelFor: `${scope}-city`,
            control: `<input class="form-input" type="text" id="${scope}-city" maxlength="100"
              value="${esc(values.city ?? '')}" placeholder="${t('settings.weatherCityPlaceholder')}">`,
          })}
        </div>
        <p class="form-hint">${t('settings.weatherCoordHint')}</p>
      </div>
    </section>
  `;
}

/** Klappt "Koordinaten von Hand" auf - dort steht ein Koordinatenfehler. */
export function openWeatherManual(container, scope) {
  const trigger = container.querySelector(`#${scope}-manual-trigger`);
  const panel = container.querySelector(`#${scope}-manual-panel`);
  if (!trigger || !panel) return;
  trigger.setAttribute('aria-expanded', 'true');
  panel.hidden = false;
}

/**
 * Ohne Koordinaten fehlt der Ort: die Meldung steht an der Ortssuche, nicht
 * als "ungueltige Koordinaten" an Feldern, die zugeklappt sind. Gibt true
 * zurueck, wenn gemeldet wurde.
 */
export function reportMissingWeatherPlace(container, scope, location) {
  const search = container.querySelector(`#${scope}-place`);
  if (!search || location.lat !== '' || location.lon !== '') return false;
  reportFieldError(search, t('settings.weatherPlaceRequired'));
  return true;
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
      setPlaceCurrent(container, scope);
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

function setPlaceCurrent(container, scope) {
  const line = container.querySelector(`#${scope}-place-current`);
  if (!line) return;
  const text = weatherPlaceText(readWeatherLocation(container, scope));
  line.textContent = text ? t('settings.weatherPlaceCurrent', { place: text }) : t('settings.weatherPlaceNone');
}

/** Der Fehlersatz zu einer gescheiterten Suche - am Feld, uebersetzt. */
export function geocodeErrorKey(error) {
  const reason = error?.data?.reason;
  if (reason === 'name_too_short') return 'settings.weatherPlaceTooShort';
  return 'settings.weatherPlaceUnavailable';
}

/**
 * Sucht den Ort im Feld und zeigt die Treffer als Liste von Knoepfen. Eine
 * spaetere Suche ueberholt eine laufende (Abbruch + Folgenummer), damit eine
 * langsame Antwort nicht die Treffer der neueren ueberschreibt.
 */
async function searchPlace(container, scope, state) {
  const input = container.querySelector(`#${scope}-place`);
  const list = container.querySelector(`#${scope}-place-results`);
  const status = container.querySelector(`#${scope}-place-status`);
  const button = container.querySelector(`#${scope}-place-btn`);
  if (!input || !list) return;
  const name = input.value.trim();
  if (name.length < 2) {
    // Die alte Trefferliste gehoert zu einem anderen Namen, und eine noch
    // laufende Suche darf sie nach der Meldung nicht wieder fuellen: abbrechen,
    // Folgenummer weiterzaehlen, Liste und Ansage leeren.
    state.controller?.abort();
    state.controller = null;
    state.seq += 1;
    if (button) button.disabled = false;
    list.replaceChildren();
    list.hidden = true;
    if (status) status.textContent = '';
    reportFieldError(input, t('settings.weatherPlaceTooShort'));
    return;
  }
  // Ein neuer Versuch mit demselben Namen feuert weder `input` noch `change`:
  // der Fehler des letzten Versuchs raeumt sich dann nicht selbst und stuende
  // neben den Treffern dieses (Codex zu R20).
  clearFieldError(input);
  state.controller?.abort();
  const controller = new AbortController();
  state.controller = controller;
  const seq = ++state.seq;
  if (button) button.disabled = true;
  let places = null;
  let failure = null;
  try {
    const params = new URLSearchParams({ name, lang: getLocale() });
    const res = await api.get(`/weather/geocode?${params}`, { signal: controller.signal });
    if (res?.data === null) failure = { data: { reason: res.reason } };
    else places = Array.isArray(res?.data) ? res.data : [];
  } catch (error) {
    if (error?.name === 'AbortError') return;
    failure = error;
  } finally {
    if (seq === state.seq && button) button.disabled = false;
  }
  if (seq !== state.seq || !isConnectedWeatherControl(input, container)) return;

  list.replaceChildren();
  if (failure) {
    list.hidden = true;
    reportFieldError(input, t(geocodeErrorKey(failure)), { focus: false });
    return;
  }
  if (!places.length) {
    list.hidden = true;
    reportFieldError(input, t('settings.weatherPlaceNotFound'), { focus: false });
    return;
  }
  for (const place of places) {
    const item = document.createElement('li');
    const option = document.createElement('button');
    option.type = 'button';
    option.className = 'weather-place__option';
    const label = document.createElement('span');
    label.className = 'weather-place__name';
    label.textContent = place.name;
    option.append(label);
    const meta = weatherPlaceMeta(place, places);
    if (meta) {
      const sub = document.createElement('span');
      sub.className = 'weather-place__meta';
      sub.textContent = meta;
      option.append(sub);
    }
    option.addEventListener('click', () => pickPlace(container, scope, place));
    item.append(option);
    list.append(item);
  }
  list.hidden = false;
  if (status) status.textContent = t('settings.weatherPlacePick');
}

function pickPlace(container, scope, place) {
  const lat = container.querySelector(`#${scope}-lat`);
  const lon = container.querySelector(`#${scope}-lon`);
  const city = container.querySelector(`#${scope}-city`);
  if (lat) lat.value = Number(place.latitude).toFixed(4);
  if (lon) lon.value = Number(place.longitude).toFixed(4);
  if (city) city.value = place.name;
  const list = container.querySelector(`#${scope}-place-results`);
  if (list) { list.replaceChildren(); list.hidden = true; }
  setPlaceCurrent(container, scope);
  const status = container.querySelector(`#${scope}-place-status`);
  if (status) status.textContent = t('settings.weatherPlaceChosen', { place: place.name });
  // Die Liste ist weg und mit ihr der fokussierte Knopf: zurueck ins Feld,
  // nicht auf den Seitengrund.
  container.querySelector(`#${scope}-place`)?.focus();
}

export function bindWeatherLocationEvents(container, scope) {
  const locateButton = container.querySelector(`#${scope}-locate-btn`);
  locateButton?.addEventListener('click', () => requestLocation(container, scope, locateButton));

  const autoLocate = container.querySelector(`#${scope}-auto-locate`);
  autoLocate?.addEventListener('change', () => {
    if (autoLocate.checked && locateButton) requestLocation(container, scope, locateButton);
  });

  const state = { seq: 0, controller: null };
  const place = container.querySelector(`#${scope}-place`);
  // Enter im Suchfeld sucht - ohne das schickte es das ganze Formular ab.
  place?.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' || isImeComposing(event)) return;
    event.preventDefault();
    searchPlace(container, scope, state);
  });
  container.querySelector(`#${scope}-place-btn`)?.addEventListener('click', () => searchPlace(container, scope, state));

  // Von Hand geaenderte Koordinaten: die Zeile "Aktuell" folgt.
  for (const field of ['lat', 'lon', 'city']) {
    container.querySelector(`#${scope}-${field}`)?.addEventListener?.('input', () => setPlaceCurrent(container, scope));
  }

  const trigger = container.querySelector(`#${scope}-manual-trigger`);
  const panel = container.querySelector(`#${scope}-manual-panel`);
  trigger?.addEventListener('click', () => {
    const next = trigger.getAttribute('aria-expanded') !== 'true';
    trigger.setAttribute('aria-expanded', String(next));
    if (panel) panel.hidden = !next;
  });
}

export const __test = { searchPlace, pickPlace };
