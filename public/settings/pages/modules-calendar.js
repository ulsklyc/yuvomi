import { api } from '/api.js';
import { formatDate, formatTime, t } from '/i18n.js';
import { esc } from '/utils/html.js';

function formatSyncTime(value) {
  if (!value) return t('settings.holidayNeverSynced');
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return t('settings.holidayNeverSynced');
  return t('settings.holidayLastSync', {
    date: `${formatDate(date)} ${formatTime(date)}`.trim(),
  });
}

function renderPage(container, preferences) {
  container.replaceChildren();
  container.insertAdjacentHTML('beforeend', `
    <section class="settings-section">
      <h2 class="settings-section__title">${t('settings.sectionHolidays')}</h2>
      <div class="settings-card">
        <h3 class="settings-card__title">${t('settings.holidayTitle')}</h3>
        <p class="settings-card-description">${t('settings.holidayDescription')}</p>

        <form class="settings-form settings-form--compact" id="holidays-form" novalidate autocomplete="off">
          <div class="form-group">
            <label class="form-label" for="holiday-country">${t('settings.holidayCountryLabel')}</label>
            <select class="form-input" id="holiday-country" disabled>
              <option value="">${t('settings.holidayCountryPlaceholder')}</option>
            </select>
          </div>
          <div class="form-group">
            <label class="form-label" for="holiday-subdivision">${t('settings.holidaySubdivisionLabel')}</label>
            <select class="form-input" id="holiday-subdivision" disabled>
              <option value="">${t('settings.holidaySubdivisionNone')}</option>
            </select>
          </div>
          <div class="form-group">
            <label class="toggle-row">
              <input type="checkbox" id="holiday-show-public"${preferences.holiday_show_public ? ' checked' : ''}>
              <span>${t('settings.holidayPublicLabel')}</span>
            </label>
          </div>
          <div class="form-group" id="holiday-public-color-group"${preferences.holiday_show_public ? '' : ' hidden'}>
            <label class="form-label" for="holiday-public-color">${t('settings.holidayPublicColor')}</label>
            <input class="form-input" type="color" id="holiday-public-color"
              value="${esc(preferences.holiday_public_color)}">
          </div>
          <div class="form-group">
            <label class="toggle-row">
              <input type="checkbox" id="holiday-show-school"${preferences.holiday_show_school ? ' checked' : ''}>
              <span>${t('settings.holidaySchoolLabel')}</span>
            </label>
          </div>
          <div class="form-group" id="holiday-school-color-group"${preferences.holiday_show_school ? '' : ' hidden'}>
            <label class="form-label" for="holiday-school-color">${t('settings.holidaySchoolColor')}</label>
            <input class="form-input" type="color" id="holiday-school-color"
              value="${esc(preferences.holiday_school_color)}">
          </div>
          <div id="holidays-form-error" class="form-error" role="alert" hidden></div>
          <div class="settings-form-actions">
            <button type="submit" class="btn btn--primary">${t('settings.holidaySaveBtn')}</button>
          </div>
        </form>

        <div class="settings-sync-info">
          <span class="form-label" id="holiday-last-sync-label">
            ${formatSyncTime(preferences.holiday_last_sync)}
          </span>
          <button type="button" class="btn btn--secondary btn--sm" id="holiday-sync-btn">
            <i data-lucide="refresh-cw" aria-hidden="true"></i>
            ${t('settings.holidaySyncBtn')}
          </button>
        </div>
      </div>
    </section>
  `);
}

function appendOptions(select, entries, selectedCode) {
  for (const entry of entries) {
    const option = document.createElement('option');
    option.value = entry.isoCode;
    option.textContent = entry.name;
    option.selected = entry.isoCode === selectedCode;
    select.appendChild(option);
  }
}

export function shouldApplySubdivisionResponse({
  requestId,
  latestRequestId,
  requestedCountry,
  currentCountry,
}) {
  return requestId === latestRequestId && requestedCountry === currentCountry;
}

export function ensureHolidayLayerSelection({ showPublic, showSchool }) {
  if (!showPublic && !showSchool) {
    return { showPublic: true, showSchool: false };
  }
  return { showPublic, showSchool };
}

function isHolidayValueResolved(entries, persistedValue) {
  return !persistedValue ||
    (Array.isArray(entries) && entries.some((entry) => entry?.isoCode === persistedValue));
}

export function isHolidayCountryResolved(countries, persistedCountry) {
  return isHolidayValueResolved(countries, persistedCountry);
}

export function applyHolidaySubdivisionSelection(discoveryState) {
  discoveryState.subdivisionReady = true;
}

export function resolveHolidayLocation({
  countryReady,
  subdivisionReady,
  selectedCountry,
  selectedSubdivision,
  persistedCountry,
  persistedSubdivision,
}) {
  const country = countryReady
    ? selectedCountry || null
    : persistedCountry || null;
  const subdivision = subdivisionReady
    ? selectedSubdivision || null
    : country === persistedCountry
      ? persistedSubdivision || null
      : null;

  return { country, subdivision };
}

export async function runHolidayDiscovery(load, onError) {
  try {
    return { ok: true, value: await load() };
  } catch (error) {
    onError(error);
    return { ok: false, value: null };
  }
}

async function loadSubdivisions(
  select,
  countrySelect,
  countryCode,
  selectedCode,
  requestState,
) {
  const requestId = ++requestState.latestRequestId;
  const noneOption = document.createElement('option');
  noneOption.value = '';
  noneOption.textContent = t('settings.holidaySubdivisionNone');
  select.replaceChildren(noneOption);
  select.disabled = true;
  if (!countryCode) return { selectedResolved: true };

  try {
    const response = await api.get(`/preferences/holidays/subdivisions/${countryCode}`);
    if (!shouldApplySubdivisionResponse({
      requestId,
      latestRequestId: requestState.latestRequestId,
      requestedCountry: countryCode,
      currentCountry: countrySelect.value,
    })) {
      return null;
    }

    const subdivisions = Array.isArray(response?.data) ? response.data : [];
    appendOptions(select, subdivisions, selectedCode);
    select.disabled = subdivisions.length === 0;
    return {
      selectedResolved: isHolidayValueResolved(subdivisions, selectedCode),
    };
  } catch (error) {
    if (shouldApplySubdivisionResponse({
      requestId,
      latestRequestId: requestState.latestRequestId,
      requestedCountry: countryCode,
      currentCountry: countrySelect.value,
    })) {
      throw error;
    }
    return null;
  }
}

function holidayPreferenceData(container, discoveryState) {
  const location = resolveHolidayLocation({
    countryReady: discoveryState.countryReady,
    subdivisionReady: discoveryState.subdivisionReady,
    selectedCountry: container.querySelector('#holiday-country')?.value || '',
    selectedSubdivision: container.querySelector('#holiday-subdivision')?.value || '',
    persistedCountry: discoveryState.persistedCountry,
    persistedSubdivision: discoveryState.persistedSubdivision,
  });

  return {
    holiday_country: location.country,
    holiday_subdivision: location.subdivision,
    holiday_show_public: container.querySelector('#holiday-show-public')?.checked ?? false,
    holiday_show_school: container.querySelector('#holiday-show-school')?.checked ?? false,
    holiday_public_color: container.querySelector('#holiday-public-color').value,
    holiday_school_color: container.querySelector('#holiday-school-color').value,
  };
}

async function bindEvents(container, preferences) {
  const form = container.querySelector('#holidays-form');
  const countrySelect = container.querySelector('#holiday-country');
  const subdivisionSelect = container.querySelector('#holiday-subdivision');
  const showPublic = container.querySelector('#holiday-show-public');
  const showSchool = container.querySelector('#holiday-show-school');
  const publicColorGroup = container.querySelector('#holiday-public-color-group');
  const schoolColorGroup = container.querySelector('#holiday-school-color-group');
  const syncButton = container.querySelector('#holiday-sync-btn');
  const errorElement = container.querySelector('#holidays-form-error');
  const subdivisionRequests = { latestRequestId: 0 };
  const discoveryState = {
    countryReady: false,
    subdivisionReady: false,
    persistedCountry: preferences.holiday_country || null,
    persistedSubdivision: preferences.holiday_subdivision || null,
  };

  const showDiscoveryError = (error) => {
    errorElement.textContent = error.message || t('common.errorGeneric');
    errorElement.hidden = false;
  };

  const updateSyncState = () => {
    const location = resolveHolidayLocation({
      countryReady: discoveryState.countryReady,
      subdivisionReady: discoveryState.subdivisionReady,
      selectedCountry: countrySelect.value,
      selectedSubdivision: subdivisionSelect.value,
      persistedCountry: discoveryState.persistedCountry,
      persistedSubdivision: discoveryState.persistedSubdivision,
    });
    syncButton.disabled = !location.country;
    syncButton.title = location.country ? '' : t('settings.holidayCountryRequired');
  };
  updateSyncState();

  countrySelect.addEventListener('change', async () => {
    errorElement.hidden = true;
    const countryCode = countrySelect.value;
    discoveryState.countryReady = true;
    discoveryState.subdivisionReady = false;
    updateSyncState();
    const result = await runHolidayDiscovery(
      () => loadSubdivisions(
        subdivisionSelect,
        countrySelect,
        countryCode,
        '',
        subdivisionRequests,
      ),
      showDiscoveryError,
    );
    if (result.ok && result.value) {
      discoveryState.subdivisionReady = result.value.selectedResolved;
    }
    updateSyncState();
  });

  subdivisionSelect.addEventListener('change', () => {
    applyHolidaySubdivisionSelection(discoveryState);
    updateSyncState();
  });

  showPublic.addEventListener('change', () => {
    publicColorGroup.hidden = !showPublic.checked;
  });
  showSchool.addEventListener('change', () => {
    schoolColorGroup.hidden = !showSchool.checked;
  });

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    errorElement.hidden = true;
    try {
      const preferenceData = holidayPreferenceData(container, discoveryState);
      await api.put('/preferences', {
        holiday_country: preferenceData.holiday_country,
        holiday_subdivision: preferenceData.holiday_subdivision,
        holiday_show_public: preferenceData.holiday_show_public,
        holiday_show_school: preferenceData.holiday_show_school,
        holiday_public_color: preferenceData.holiday_public_color,
        holiday_school_color: preferenceData.holiday_school_color,
      });
      discoveryState.persistedCountry = preferenceData.holiday_country;
      discoveryState.persistedSubdivision = preferenceData.holiday_subdivision;
      window.oikos?.showToast(t('settings.holidaySaved'), 'success');
    } catch (error) {
      errorElement.textContent = error.message || t('common.errorGeneric');
      errorElement.hidden = false;
    }
  });

  syncButton.addEventListener('click', async () => {
    const currentPreferenceData = holidayPreferenceData(container, discoveryState);
    if (!currentPreferenceData.holiday_country) {
      window.oikos?.showToast(t('settings.holidayCountryRequired'), 'warning');
      return;
    }

    const layerSelection = ensureHolidayLayerSelection({
      showPublic: showPublic.checked,
      showSchool: showSchool.checked,
    });
    showPublic.checked = layerSelection.showPublic;
    showSchool.checked = layerSelection.showSchool;
    publicColorGroup.hidden = !layerSelection.showPublic;
    schoolColorGroup.hidden = !layerSelection.showSchool;

    const preferenceData = holidayPreferenceData(container, discoveryState);
    syncButton.disabled = true;
    try {
      await api.put('/preferences', {
        holiday_country: preferenceData.holiday_country,
        holiday_subdivision: preferenceData.holiday_subdivision,
        holiday_show_public: preferenceData.holiday_show_public,
        holiday_show_school: preferenceData.holiday_show_school,
        holiday_public_color: preferenceData.holiday_public_color,
        holiday_school_color: preferenceData.holiday_school_color,
      });
      discoveryState.persistedCountry = preferenceData.holiday_country;
      discoveryState.persistedSubdivision = preferenceData.holiday_subdivision;
      const response = await api.post('/preferences/holidays/sync', {});
      const lastSyncLabel = container.querySelector('#holiday-last-sync-label');
      if (lastSyncLabel && response?.data?.last_sync) {
        lastSyncLabel.textContent = formatSyncTime(response.data.last_sync);
      }
      window.oikos?.showToast(t('settings.holidaySynced'), 'success');
    } catch (error) {
      window.oikos?.showToast(error.message || t('settings.holidaySyncError'), 'danger');
    } finally {
      updateSyncState();
    }
  });

  const countriesResult = await runHolidayDiscovery(
    () => api.get('/preferences/holidays/countries'),
    showDiscoveryError,
  );
  if (!countriesResult.ok || !container.isConnected) return;

  const countries = Array.isArray(countriesResult.value?.data)
    ? countriesResult.value.data
    : [];
  appendOptions(
    countrySelect,
    countries,
    preferences.holiday_country || '',
  );
  countrySelect.disabled = false;
  discoveryState.countryReady = isHolidayCountryResolved(
    countries,
    preferences.holiday_country,
  );

  if (!preferences.holiday_country) {
    discoveryState.subdivisionReady = true;
  } else if (discoveryState.countryReady) {
    const subdivisionsResult = await runHolidayDiscovery(
      () => loadSubdivisions(
        subdivisionSelect,
        countrySelect,
        preferences.holiday_country,
        preferences.holiday_subdivision || '',
        subdivisionRequests,
      ),
      showDiscoveryError,
    );
    if (subdivisionsResult.ok && subdivisionsResult.value) {
      discoveryState.subdivisionReady = subdivisionsResult.value.selectedResolved;
    }
  }
  updateSyncState();
}

export async function render(container, { user }) {
  void user;
  const response = await api.get('/preferences');
  const preferences = response?.data ?? {};
  renderPage(container, preferences);
  await bindEvents(container, preferences);
  window.lucide?.createIcons({ el: container });
}
