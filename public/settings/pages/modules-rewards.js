import { api } from '/api.js';
import { t } from '/i18n.js';
import { confirmModal } from '/components/modal.js';
import { toggleRowHtml } from '/settings/components.js';
import { getPreferences, savePreferences } from '/settings/preferences-cache.js';

// Spiegelt MAX_POINTS in server/routes/tasks.js.
const MAX_TASK_POINTS = 10000;

// Belohnungen ist kein eigener Boolean-Schalter, sondern Teil der modulweiten
// Sichtbarkeit (disabled_modules). „Aktiviert" == Modul-Slug NICHT in der Liste.
function isRewardsEnabled(preferences) {
  const disabled = Array.isArray(preferences.disabled_modules) ? preferences.disabled_modules : [];
  return !disabled.includes('rewards');
}

function renderPage(container, preferences) {
  container.replaceChildren();
  container.insertAdjacentHTML('beforeend', `
    <section class="settings-section">
      <div class="settings-card">
        <h2 class="settings-card__title">${t('settings.rewardsEnableTitle')}</h2>
        <p class="form-hint">${t('settings.rewardsEnableHint')}</p>
        ${toggleRowHtml({
          control: 'switch',
          label: t('settings.rewardsEnableLabel'),
          checked: isRewardsEnabled(preferences),
          attrs: { id: 'rewards-enabled' },
        })}
      </div>
      <div class="settings-card">
        <h2 class="settings-card__title">${t('settings.rewardsApprovalTitle')}</h2>
        <p class="form-hint">${t('settings.rewardsApprovalHint')}</p>
        ${toggleRowHtml({
          control: 'switch',
          label: t('settings.rewardsApprovalLabel'),
          checked: preferences.rewards_require_approval !== false,
          attrs: { id: 'rewards-require-approval' },
        })}
      </div>
      <div class="settings-card">
        <h2 class="settings-card__title">${t('settings.rewardsDefaultPointsTitle')}</h2>
        <p class="form-hint">${t('settings.rewardsDefaultPointsHint')}</p>
        <form class="settings-form settings-form--compact" id="rewards-default-points-form" novalidate autocomplete="off">
          <div class="form-group">
            <label class="form-label" for="rewards-default-points">${t('settings.rewardsDefaultPointsLabel')}</label>
            <input class="form-input" type="number" id="rewards-default-points" inputmode="numeric"
                   min="0" max="${MAX_TASK_POINTS}" step="1"
                   aria-describedby="rewards-default-points-off-hint rewards-default-points-error"
                   value="${Number(preferences.tasks_default_points) || 0}">
            <p class="settings-card-description" id="rewards-default-points-off-hint">${t('settings.rewardsDefaultPointsOffHint')}</p>
          </div>
          <div id="rewards-default-points-error" class="form-error" role="alert" hidden></div>
          <div class="settings-form-actions">
            <button type="submit" class="btn btn--primary">${t('common.save')}</button>
          </div>
        </form>
      </div>
    </section>
  `);
}

function bindEvents(container, preferences) {
  const enableToggle = container.querySelector('#rewards-enabled');
  enableToggle?.addEventListener('change', async () => {
    enableToggle.disabled = true;
    const current = Array.isArray(preferences.disabled_modules) ? preferences.disabled_modules : [];
    const next = enableToggle.checked
      ? current.filter((m) => m !== 'rewards')
      : [...new Set([...current, 'rewards'])];
    try {
      const res = await savePreferences({ disabled_modules: next });
      const saved = res?.data?.disabled_modules ?? next;
      preferences.disabled_modules = saved;
      window.yuvomi?.setDisabledModules?.(saved);
      window.yuvomi?.showToast(t('settings.rewardsSaved'), 'success');
    } catch (error) {
      enableToggle.checked = !enableToggle.checked;
      window.yuvomi?.showToast(error.message || t('common.errorGeneric'), 'danger');
    } finally {
      enableToggle.disabled = false;
    }
  });

  const approvalToggle = container.querySelector('#rewards-require-approval');
  approvalToggle?.addEventListener('change', async () => {
    approvalToggle.disabled = true;
    try {
      await savePreferences({ rewards_require_approval: approvalToggle.checked });
      window.yuvomi?.showToast(t('settings.rewardsSaved'), 'success');
    } catch (error) {
      approvalToggle.checked = !approvalToggle.checked;
      window.yuvomi?.showToast(error.message || t('common.errorGeneric'), 'danger');
    } finally {
      approvalToggle.disabled = false;
    }
  });

  bindDefaultPoints(container, preferences);
}

/**
 * Standard-Punkte für neue Aufgaben (#578). Kein Instant-Save: nach dem
 * Speichern folgt die Rückfrage, ob bestehende Aufgaben mitgezogen werden
 * sollen — dafür braucht es einen bewussten Abschluss der Eingabe.
 */
function bindDefaultPoints(container, preferences) {
  const form     = container.querySelector('#rewards-default-points-form');
  const input    = container.querySelector('#rewards-default-points');
  const errorEl  = container.querySelector('#rewards-default-points-error');
  if (!form || !input) return;

  let persisted = Number(preferences.tasks_default_points) || 0;

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    errorEl.hidden = true;

    const next = Math.trunc(Number(input.value));
    if (!Number.isFinite(next) || next < 0 || next > MAX_TASK_POINTS) {
      errorEl.textContent = t('settings.rewardsDefaultPointsInvalid', { max: MAX_TASK_POINTS });
      errorEl.hidden = false;
      return;
    }
    if (next === persisted) return;

    // Feld mitsperren, nicht nur den Button: sonst überschreibt der Erfolgspfad
    // eine Eingabe, die während des laufenden Requests getippt wurde.
    const submitBtn = form.querySelector('button[type="submit"]');
    submitBtn.disabled = true;
    input.disabled = true;
    const previous = persisted;
    try {
      await savePreferences({ tasks_default_points: next });
      persisted = next;
      input.value = String(next);
      preferences.tasks_default_points = next;
      window.yuvomi?.showToast(t('settings.rewardsDefaultPointsSaved'), 'success');
    } catch (error) {
      input.value = String(previous); // Rollback
      errorEl.textContent = error.message || t('common.errorGeneric');
      errorEl.hidden = false;
      return;
    } finally {
      if (submitBtn.isConnected) submitBtn.disabled = false;
      if (input.isConnected) input.disabled = false;
    }

    await offerRebase(previous, next);
  });
}

/**
 * Nach einer Änderung anbieten, noch nicht erledigte Aufgaben nachzuziehen, die
 * auf dem alten Standard stehen. Erledigte bleiben außen vor, weil ihre Punkte
 * bereits im Ledger gutgeschrieben sind. Die Anzahl steht im Dialog, damit der
 * Wechsel vor der Bestätigung sichtbar ist.
 */
async function offerRebase(from, to) {
  if (from <= 0) return; // ohne vorherigen Standard gibt es nichts nachzuziehen

  let count = 0;
  try {
    const res = await api.get(`/tasks/points/affected?points=${from}`);
    count = Number(res?.data?.count) || 0;
  } catch {
    return; // Nachziehen ist optional — der neue Standard ist bereits gespeichert
  }
  if (count <= 0) return;

  const confirmed = await confirmModal(
    t('settings.rewardsDefaultPointsRebaseTitle', { count, from, to }),
    {
      confirmLabel: t('settings.rewardsDefaultPointsRebaseConfirm'),
      detail: t('settings.rewardsDefaultPointsRebaseDetail'),
    },
  );
  if (!confirmed) return;

  try {
    const res = await api.post('/tasks/points/rebase', { from, to });
    const updated = Number(res?.data?.updated) || 0;
    window.yuvomi?.showToast(t('settings.rewardsDefaultPointsRebased', { count: updated }), 'success');
  } catch (error) {
    window.yuvomi?.showToast(error.message || t('common.errorGeneric'), 'danger');
  }
}

export async function render(container, { user }) {
  void user;
  const preferences = await getPreferences();
  renderPage(container, preferences);
  bindEvents(container, preferences);
}
