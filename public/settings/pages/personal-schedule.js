import { api } from '/api.js';
import { t } from '/i18n.js';
import { esc } from '/utils/html.js';
import { toggleRowHtml } from '/settings/components.js';
import { reminderOffsetOptions, pickCustomReminderOffset } from '/utils/schedule-reminder-offset.js';

/**
 * Schichtplan-Einstellungen, die nur fuer MICH gelten: Erinnerung vor der
 * eigenen Schicht, Ueberstunden markieren, eigene Wochenstunden.
 *
 * SEIT R14 HIER UND NICHT MEHR IM TAB "AUSWERTUNG" (Re-Critique 2026-09-28,
 * A2 P2-3): dort stand die Karte "Meine Einstellungen" in einer Leseansicht,
 * waehrend das Modulblatt nur die Vorlagen des Haushalts fuehrte - zwei Orte
 * fuer Schichtplan-Einstellungen, der eine versteckt. Jetzt stehen beide im
 * Blatt des Moduls: dieser Abschnitt "Fuer mich", die Vorlagen "Fuer den
 * Haushalt" (modules-options.js).
 *
 * Kein Admin-Tor und keine Modul-Schreibsperre: die Werte haengen an der
 * eigenen users-Zeile (server/routes/schedule-preferences.js), und
 * server/index.js nimmt `/schedule/preferences` bewusst aus der Modul-Sperre
 * heraus (S-12) - auch ein Nur-lesen-Mitglied darf sie speichern.
 */
export const DEFAULT_WEEKLY_HOURS = 40;

export function scheduleSettingsHtml(preferences = {}) {
  const offset = preferences.reminderOffsetMinutes ?? null;
  const active = offset != null;
  const overtimeEnabled = preferences.overtimeEnabled !== false;
  const weeklyHours = preferences.weeklyHours ?? DEFAULT_WEEKLY_HOURS;
  return `
    <section class="settings-section schedule-reminder-settings">
      <!-- Bewusst NICHT der Blatt-Titel: die Shell zeigt ihn bereits darueber
           (Guard in test-typography.js). -->
      <h2 class="settings-section__title">${esc(t('schedule.mySettings'))}</h2>
      <div class="settings-card">
        ${toggleRowHtml({ label: t('schedule.reminderToggle'), checked: active, control: 'switch', attrs: { id: 'schedule-reminder-toggle' } })}
        <div class="form-group">
          <label class="form-label" for="schedule-reminder-offset">${esc(t('schedule.reminderLeadTime'))}</label>
          <select class="form-input" id="schedule-reminder-offset" data-previous-value="${esc(String(offset ?? 15))}"${active ? '' : ' disabled'}>${reminderOffsetOptions(offset)}</select>
          <p class="form-hint">${esc(t('schedule.reminderHint'))}</p>
        </div>
      </div>
      <div class="settings-card">
        ${toggleRowHtml({ label: t('schedule.overtimeTrackingToggle'), checked: overtimeEnabled, control: 'switch', attrs: { id: 'schedule-overtime-toggle' } })}
        <p class="form-hint">${esc(t('schedule.overtimeTrackingHint'))}</p>
        <div class="form-group">
          <label class="form-label" for="schedule-weekly-hours">${esc(t('schedule.weeklyHoursLabel'))}</label>
          <input class="form-input" type="number" inputmode="numeric" min="1" max="168" step="1" id="schedule-weekly-hours" value="${esc(String(weeklyHours))}"${overtimeEnabled ? '' : ' disabled'}>
          <p class="form-hint">${esc(t('schedule.weeklyHoursHint'))}</p>
        </div>
      </div>
    </section>`;
}

async function save(patch) {
  const result = await api.put('/schedule/preferences', patch);
  window.yuvomi?.showToast(t('schedule.settingsSaved'), 'success');
  return result.data ?? {};
}

// Sofort-Speichern wie jedes Blatt; schlaegt es fehl, springt das Feld auf den
// letzten gespeicherten Wert zurueck, statt einen abgelehnten Wert stehen zu
// lassen.
export function bindScheduleSettings(container, preferences = {}) {
  let persisted = { ...preferences };
  const fail = (error) => window.yuvomi?.showToast(error?.message || t('common.errorGeneric'), 'danger');
  const reminderToggle = container.querySelector('#schedule-reminder-toggle');
  const offsetSelect = container.querySelector('#schedule-reminder-offset');
  const overtimeToggle = container.querySelector('#schedule-overtime-toggle');
  const hoursInput = container.querySelector('#schedule-weekly-hours');

  reminderToggle?.addEventListener('change', async () => {
    // S-25: sofort sperren/entsperren, nicht erst nach dem Roundtrip.
    if (offsetSelect) offsetSelect.disabled = !reminderToggle.checked;
    const minutes = reminderToggle.checked ? Number(offsetSelect?.value ?? 15) : null;
    try { persisted = { ...persisted, ...(await save({ reminderOffsetMinutes: minutes })) }; }
    catch (error) {
      reminderToggle.checked = persisted.reminderOffsetMinutes != null;
      if (offsetSelect) offsetSelect.disabled = !reminderToggle.checked;
      fail(error);
    }
  });

  offsetSelect?.addEventListener('change', async () => {
    const commit = async (minutes) => {
      try { persisted = { ...persisted, ...(await save({ reminderOffsetMinutes: minutes })) }; }
      catch (error) { offsetSelect.value = String(persisted.reminderOffsetMinutes ?? 15); fail(error); }
    };
    // S-23: "Eigener Wert ..." speichert selbst nichts - erst die Eingabe.
    if (offsetSelect.value === 'custom') {
      await pickCustomReminderOffset(offsetSelect, commit);
      return;
    }
    offsetSelect.dataset.previousValue = offsetSelect.value;
    await commit(Number(offsetSelect.value));
  });

  overtimeToggle?.addEventListener('change', async () => {
    // S-24: Aus schaltet die Wochenstunden UND die Ueberstunden-Kachel der
    // Auswertung ab; das Feld sperrt sofort.
    if (hoursInput) hoursInput.disabled = !overtimeToggle.checked;
    try { persisted = { ...persisted, ...(await save({ overtimeEnabled: overtimeToggle.checked })) }; }
    catch (error) {
      overtimeToggle.checked = persisted.overtimeEnabled !== false;
      if (hoursInput) hoursInput.disabled = !overtimeToggle.checked;
      fail(error);
    }
  });

  hoursInput?.addEventListener('change', async () => {
    const hours = Math.min(168, Math.max(1, Math.round(Number(hoursInput.value) || DEFAULT_WEEKLY_HOURS)));
    hoursInput.value = String(hours);
    try { persisted = { ...persisted, ...(await save({ weeklyHours: hours })) }; }
    catch (error) { hoursInput.value = String(persisted.weeklyHours ?? DEFAULT_WEEKLY_HOURS); fail(error); }
  });
}

export async function render(container, { user }) {
  void user;
  const preferences = await api.get('/schedule/preferences').then((res) => res.data ?? {}).catch(() => ({}));
  container.replaceChildren();
  container.insertAdjacentHTML('beforeend', scheduleSettingsHtml(preferences));
  bindScheduleSettings(container, preferences);
}
