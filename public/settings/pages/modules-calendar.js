import { api } from '/api.js';
import { formatDate, formatTime, t } from '/i18n.js';
import { esc } from '/utils/html.js';
import { weekStartIndex, weekdayOrder } from '/utils/date.js';

// Wochenstart-Optionen; Labels aus dem bestehenden Kalender-i18n (kein neuer
// Übersetzungsbedarf für die Wochentagsnamen).
const WEEK_START_OPTIONS = [
  { value: 'monday', labelKey: 'calendar.dayLongMonday' },
  { value: 'sunday', labelKey: 'calendar.dayLongSunday' },
  { value: 'saturday', labelKey: 'calendar.dayLongSaturday' },
];
const VALID_WEEK_STARTS = WEEK_START_OPTIONS.map((o) => o.value);
const DAY_NAMES_SHORT = () => [
  t('calendar.dayShortSunday'), t('calendar.dayShortMonday'), t('calendar.dayShortTuesday'),
  t('calendar.dayShortWednesday'), t('calendar.dayShortThursday'), t('calendar.dayShortFriday'),
  t('calendar.dayShortSaturday'),
];

// Sieben Mini-Zellen in der Reihenfolge des gewählten Wochenstarts; die erste
// Zelle ist hervorgehoben, damit die Wahl sofort sichtbar wird.
function weekStartPreviewHtml(weekStart) {
  const names = DAY_NAMES_SHORT();
  return weekdayOrder(weekStartIndex(weekStart)).map((idx, pos) => (
    `<span class="week-start-preview__cell${pos === 0 ? ' week-start-preview__cell--start' : ''}">${esc(names[idx])}</span>`
  )).join('');
}

function formatSyncTime(value) {
  if (!value) return t('settings.holidayNeverSynced');
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return t('settings.holidayNeverSynced');
  return t('settings.holidayLastSync', {
    date: `${formatDate(date)} ${formatTime(date)}`.trim(),
  });
}

const DURATION_OPTIONS = [15, 30, 45, 60, 90, 120];

function durationOptionLabel(minutes) {
  return t('settings.calendarDurationMinutes', { count: minutes });
}

// Standard-Erinnerungs-Offsets (Minuten) für neue Termine (#497). Labels aus dem
// bestehenden reminders.offset*-Wortschatz (kein neuer Übersetzungsbedarf dafür).
const DEFAULT_REMINDER_OPTIONS = [
  { value: 0,     labelKey: 'reminders.offsetAtTime' },
  { value: 15,    labelKey: 'reminders.offset15min' },
  { value: 60,    labelKey: 'reminders.offset1hour' },
  { value: 1440,  labelKey: 'reminders.offset1day' },
  { value: 2880,  labelKey: 'reminders.offset2days' },
  { value: 10080, labelKey: 'reminders.offset1week' },
  { value: 20160, labelKey: 'reminders.offset2weeks' },
];
const MAX_DEFAULT_REMINDERS = 5;

// Kleiner lokaler Debounce (kein geteilter Util im Projekt): koaleziert schnelle
// Mehrfach-Auswahl zu einem einzigen Speichern + einem Toast.
function debounce(fn, ms) {
  let timer = null;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

function defaultRemindersCardHtml(preferences) {
  const selected = new Set(
    Array.isArray(preferences.calendar_default_reminders) ? preferences.calendar_default_reminders.map(Number) : []
  );
  const assignMe = !!preferences.calendar_default_assign_me;
  const checkboxes = DEFAULT_REMINDER_OPTIONS.map((o) => `
    <label class="reminder-preset">
      <input type="checkbox" class="js-default-reminder" value="${o.value}"${selected.has(o.value) ? ' checked' : ''}>
      <span>${esc(t(o.labelKey))}</span>
    </label>`).join('');
  return `
    <div class="settings-card">
      <h3 class="settings-card__title">${t('settings.calendarDefaultsTitle')}</h3>
      <p class="settings-card-description">${t('settings.calendarDefaultsDescription')}</p>

      <div class="form-group">
        <label class="toggle-row">
          <input type="checkbox" id="calendar-default-assign-me"${assignMe ? ' checked' : ''}>
          <span>${t('settings.calendarAssignMeLabel')}</span>
        </label>
      </div>

      <div class="form-group">
        <span class="form-label" id="calendar-default-reminders-label">${t('settings.calendarDefaultRemindersLabel')}</span>
        <p class="settings-card-description">${t('settings.calendarDefaultRemindersHint')}</p>
        <div id="calendar-default-reminders" class="reminder-preset-group" role="group" aria-labelledby="calendar-default-reminders-label">
          ${checkboxes}
        </div>
      </div>
    </div>`;
}

function renderPage(container, preferences) {
  const currentDuration = Number(preferences.calendar_default_duration) || 60;
  const currentWeekStart = VALID_WEEK_STARTS.includes(preferences.week_start)
    ? preferences.week_start
    : 'monday';
  container.replaceChildren();
  container.insertAdjacentHTML('beforeend', `
    <section class="settings-section">
      <h2 class="settings-section__title">${t('settings.calendarSectionEvents')}</h2>
      <div class="settings-card">
        <h3 class="settings-card__title">${t('settings.calendarDurationTitle')}</h3>
        <p class="settings-card-description">${t('settings.calendarDurationDescription')}</p>

        <div class="form-group">
          <label class="form-label" for="calendar-default-duration">${t('settings.calendarDurationLabel')}</label>
          <select class="form-input" id="calendar-default-duration">
            ${DURATION_OPTIONS.map((m) => `<option value="${m}"${m === currentDuration ? ' selected' : ''}>${esc(durationOptionLabel(m))}</option>`).join('')}
          </select>
        </div>
      </div>

      ${defaultRemindersCardHtml(preferences)}
    </section>

    <section class="settings-section">
      <h2 class="settings-section__title">${t('settings.calendarSectionView')}</h2>
      <div class="settings-card">
        <h3 class="settings-card__title">${t('settings.weekStartTitle')}</h3>
        <p class="settings-card-description">${t('settings.weekStartDescription')}</p>

        <div class="theme-toggle" id="week-start-toggle" role="group" aria-label="${t('settings.weekStartTitle')}">
          ${WEEK_START_OPTIONS.map((o) => `
            <button type="button" class="theme-toggle__btn ${o.value === currentWeekStart ? 'theme-toggle__btn--active' : ''}"
              data-week-start="${o.value}" aria-pressed="${o.value === currentWeekStart}">
              ${t(o.labelKey)}
            </button>`).join('')}
        </div>

        <div class="week-start-preview" id="week-start-preview" aria-hidden="true">
          ${weekStartPreviewHtml(currentWeekStart)}
        </div>
      </div>
    </section>

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
          <div class="form-group" id="holiday-group-group" hidden>
            <label class="form-label" for="holiday-group">${t('settings.holidayGroupLabel')}</label>
            <select class="form-input" id="holiday-group" disabled>
              <option value="">${t('settings.holidayGroupNone')}</option>
            </select>
            <p class="settings-card-description">${t('settings.holidayGroupHint')}</p>
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

/**
 * Schulferien-Gruppen einer Subdivision laden und den Picker nur einblenden,
 * wenn es mindestens zwei Regimes gibt (mehrsprachige Kantone, #434). Bei 0/1
 * Gruppe bleibt er verborgen, weil keine Mehrdeutigkeit besteht.
 */
async function loadGroups(
  select,
  groupContainer,
  countryCode,
  subdivisionCode,
  selectedCode,
  requestState,
) {
  const requestId = ++requestState.latestRequestId;
  const noneOption = document.createElement('option');
  noneOption.value = '';
  noneOption.textContent = t('settings.holidayGroupNone');
  select.replaceChildren(noneOption);
  select.disabled = true;
  groupContainer.hidden = true;

  if (!countryCode || !subdivisionCode) return;

  try {
    const response = await api.get(
      `/preferences/holidays/groups/${countryCode}/${subdivisionCode}`,
    );
    // Zwischenzeitlich neu gewählt → verworfene Antwort ignorieren.
    if (requestId !== requestState.latestRequestId) return;

    const groups = Array.isArray(response?.data) ? response.data : [];
    if (groups.length < 2) return;

    for (const g of groups) {
      const option = document.createElement('option');
      option.value = g.code;
      option.textContent = g.name;
      option.selected = g.code === selectedCode;
      select.appendChild(option);
    }
    select.disabled = false;
    groupContainer.hidden = false;
  } catch {
    // Gruppen sind optional – Fehler still schlucken, Picker bleibt verborgen.
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

  const groupEl = container.querySelector('#holiday-group');

  return {
    holiday_country: location.country,
    holiday_subdivision: location.subdivision,
    // Ohne Subdivision kann es keine Gruppe geben.
    holiday_group: location.subdivision ? (groupEl?.value || null) : null,
    holiday_show_public: container.querySelector('#holiday-show-public')?.checked ?? false,
    holiday_show_school: container.querySelector('#holiday-show-school')?.checked ?? false,
    holiday_public_color: container.querySelector('#holiday-public-color').value,
    holiday_school_color: container.querySelector('#holiday-school-color').value,
  };
}

function bindWeekStart(container, preferences) {
  const toggle = container.querySelector('#week-start-toggle');
  const preview = container.querySelector('#week-start-preview');
  if (!toggle) return;

  let current = VALID_WEEK_STARTS.includes(preferences.week_start)
    ? preferences.week_start
    : 'monday';

  const paint = (value) => {
    toggle.querySelectorAll('.theme-toggle__btn').forEach((btn) => {
      const active = btn.dataset.weekStart === value;
      btn.classList.toggle('theme-toggle__btn--active', active);
      btn.setAttribute('aria-pressed', String(active));
    });
    if (preview) {
      preview.replaceChildren();
      preview.insertAdjacentHTML('beforeend', weekStartPreviewHtml(value));
    }
  };

  toggle.addEventListener('click', async (event) => {
    const button = event.target.closest('[data-week-start]');
    if (!button) return;
    const value = button.dataset.weekStart;
    if (value === current || !VALID_WEEK_STARTS.includes(value)) return;

    const previous = current;
    current = value;
    paint(value); // optimistisch – Klick fühlt sich sofort an
    try {
      await api.put('/preferences', { week_start: value });
      // Parität zu date-format-changed/time-format-changed: erlaubt offenen
      // Ansichten, den Wochenstart ohne Neuladen zu übernehmen.
      window.dispatchEvent(new CustomEvent('week-start-changed', { detail: { weekStart: value } }));
      window.yuvomi?.showToast(t('settings.weekStartSaved'), 'success');
    } catch (error) {
      current = previous;
      paint(previous); // Rollback bei Fehler
      window.yuvomi?.showToast(error.message || t('common.errorGeneric'), 'danger');
    }
  });
}

// Standardwerte für neue Termine (#497/#498): Instant-Save wie beim Wochenstart.
function bindCalendarDefaults(container) {
  const assignMe = container.querySelector('#calendar-default-assign-me');
  assignMe?.addEventListener('change', async () => {
    const value = assignMe.checked;
    assignMe.disabled = true;
    try {
      await api.put('/preferences', { calendar_default_assign_me: value });
      window.yuvomi?.showToast(t('settings.calendarDefaultsSaved'), 'success');
    } catch (error) {
      assignMe.checked = !value; // Rollback
      window.yuvomi?.showToast(error.message || t('common.errorGeneric'), 'danger');
    } finally {
      if (assignMe.isConnected) assignMe.disabled = false;
    }
  });

  const remindersBox = container.querySelector('#calendar-default-reminders');
  if (!remindersBox) return;
  let persisted = collectDefaultReminders(remindersBox);

  // Debounced: schnelle Mehrfach-Auswahl erzeugt EIN Speichern + EINEN Toast,
  // statt einen pro Klick. Rollback auf den letzten persistierten Stand bei Fehler.
  const persistReminders = debounce(async () => {
    const selected = collectDefaultReminders(remindersBox);
    try {
      await api.put('/preferences', { calendar_default_reminders: selected });
      persisted = selected;
      if (remindersBox.isConnected) window.yuvomi?.showToast(t('settings.calendarDefaultsSaved'), 'success');
    } catch (error) {
      const keep = new Set(persisted);
      remindersBox.querySelectorAll('.js-default-reminder').forEach((el) => {
        el.checked = keep.has(Number(el.value));
      });
      window.yuvomi?.showToast(error.message || t('common.errorGeneric'), 'danger');
    }
  }, 500);

  remindersBox.addEventListener('change', (event) => {
    const box = event.target.closest('.js-default-reminder');
    if (!box) return;
    if (collectDefaultReminders(remindersBox).length > MAX_DEFAULT_REMINDERS) {
      box.checked = false; // Cap: die gerade gesetzte Auswahl zurücknehmen
      window.yuvomi?.showToast(t('settings.calendarDefaultRemindersMax', { count: MAX_DEFAULT_REMINDERS }), 'warning');
      return;
    }
    persistReminders();
  });
}

function collectDefaultReminders(box) {
  return [...box.querySelectorAll('.js-default-reminder')]
    .filter((el) => el.checked)
    .map((el) => Number(el.value))
    .sort((a, b) => a - b);
}

async function bindEvents(container, preferences) {
  bindWeekStart(container, preferences);

  // Instant-Save wie beim Wochenstart – ein einzelner Wert braucht keinen
  // separaten Speichern-Button (vereinheitlicht die beiden Ansicht-Controls).
  const durationSelect = container.querySelector('#calendar-default-duration');
  let persistedDuration = durationSelect?.value;
  durationSelect?.addEventListener('change', async () => {
    const minutes = Number(durationSelect.value) || 60;
    const previous = persistedDuration;
    persistedDuration = durationSelect.value;
    durationSelect.disabled = true;
    try {
      await api.put('/preferences', { calendar_default_duration: minutes });
      window.yuvomi?.showToast(t('settings.calendarDurationSaved'), 'success');
    } catch (error) {
      persistedDuration = previous;
      durationSelect.value = previous; // Rollback bei Fehler
      window.yuvomi?.showToast(error.message || t('common.errorGeneric'), 'danger');
    } finally {
      if (durationSelect.isConnected) durationSelect.disabled = false;
    }
  });

  bindCalendarDefaults(container);

  const form = container.querySelector('#holidays-form');
  const countrySelect = container.querySelector('#holiday-country');
  const subdivisionSelect = container.querySelector('#holiday-subdivision');
  const groupSelect = container.querySelector('#holiday-group');
  const groupGroup = container.querySelector('#holiday-group-group');
  const showPublic = container.querySelector('#holiday-show-public');
  const showSchool = container.querySelector('#holiday-show-school');
  const publicColorGroup = container.querySelector('#holiday-public-color-group');
  const schoolColorGroup = container.querySelector('#holiday-school-color-group');
  const syncButton = container.querySelector('#holiday-sync-btn');
  const errorElement = container.querySelector('#holidays-form-error');
  const subdivisionRequests = { latestRequestId: 0 };
  const groupRequests = { latestRequestId: 0 };
  const discoveryState = {
    countryReady: false,
    subdivisionReady: false,
    persistedCountry: preferences.holiday_country || null,
    persistedSubdivision: preferences.holiday_subdivision || null,
    persistedGroup: preferences.holiday_group || null,
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
    // Land gewechselt → Subdivision zurückgesetzt → Gruppen-Picker leeren.
    await loadGroups(groupSelect, groupGroup, countryCode, subdivisionSelect.value, '', groupRequests);
    updateSyncState();
  });

  subdivisionSelect.addEventListener('change', async () => {
    applyHolidaySubdivisionSelection(discoveryState);
    updateSyncState();
    // Subdivision gewechselt → passende Ferien-Gruppen neu laden, Auswahl zurück.
    await loadGroups(groupSelect, groupGroup, countrySelect.value, subdivisionSelect.value, '', groupRequests);
  });

  groupSelect.addEventListener('change', () => {
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
        holiday_group: preferenceData.holiday_group,
        holiday_show_public: preferenceData.holiday_show_public,
        holiday_show_school: preferenceData.holiday_show_school,
        holiday_public_color: preferenceData.holiday_public_color,
        holiday_school_color: preferenceData.holiday_school_color,
      });
      discoveryState.persistedCountry = preferenceData.holiday_country;
      discoveryState.persistedSubdivision = preferenceData.holiday_subdivision;
      discoveryState.persistedGroup = preferenceData.holiday_group;
      window.yuvomi?.showToast(t('settings.holidaySaved'), 'success');
    } catch (error) {
      errorElement.textContent = error.message || t('common.errorGeneric');
      errorElement.hidden = false;
    }
  });

  syncButton.addEventListener('click', async () => {
    const currentPreferenceData = holidayPreferenceData(container, discoveryState);
    if (!currentPreferenceData.holiday_country) {
      window.yuvomi?.showToast(t('settings.holidayCountryRequired'), 'warning');
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
        holiday_group: preferenceData.holiday_group,
        holiday_show_public: preferenceData.holiday_show_public,
        holiday_show_school: preferenceData.holiday_show_school,
        holiday_public_color: preferenceData.holiday_public_color,
        holiday_school_color: preferenceData.holiday_school_color,
      });
      discoveryState.persistedCountry = preferenceData.holiday_country;
      discoveryState.persistedSubdivision = preferenceData.holiday_subdivision;
      discoveryState.persistedGroup = preferenceData.holiday_group;
      const response = await api.post('/preferences/holidays/sync', {});
      const lastSyncLabel = container.querySelector('#holiday-last-sync-label');
      if (lastSyncLabel && response?.data?.last_sync) {
        lastSyncLabel.textContent = formatSyncTime(response.data.last_sync);
      }
      window.yuvomi?.showToast(t('settings.holidaySynced'), 'success');
    } catch (error) {
      window.yuvomi?.showToast(error.message || t('settings.holidaySyncError'), 'danger');
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
    if (preferences.holiday_subdivision) {
      await loadGroups(
        groupSelect,
        groupGroup,
        preferences.holiday_country,
        preferences.holiday_subdivision,
        preferences.holiday_group || '',
        groupRequests,
      );
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
