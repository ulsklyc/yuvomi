/**
 * Settings-Seite: Push-Benachrichtigungen (pro Gerät).
 */
import { t } from '/i18n.js';
import { pushSupported, pushStatus, enablePush, disablePush } from '/push.js';
import { api } from '/api.js';

function renderPage(container) {
  container.replaceChildren();
  container.insertAdjacentHTML('beforeend', `
    <section class="settings-section">
      <h2 class="settings-section__title">${t('settings.notificationsTitle')}</h2>
      <div class="settings-card">
        <div class="settings-card__body">
          <h3 class="settings-card__title">${t('settings.pushToggleTitle')}</h3>
          <p class="form-hint" id="push-status" aria-live="polite">${t('settings.pushChecking')}</p>
          <div class="settings-form-actions">
            <label class="toggle-row">
              <input type="checkbox" id="push-toggle" disabled>
              <span>${t('settings.pushToggleLabel')}</span>
            </label>
          </div>
          <div class="settings-form-actions">
            <button type="button" class="btn btn--secondary" id="push-test-btn" disabled>
              <i data-lucide="bell-ring" aria-hidden="true"></i>
              <span>${t('settings.pushTestButton')}</span>
            </button>
          </div>
        </div>
      </div>
    </section>
  `);
}

export async function render(container, { user } = {}) {
  void user;
  try {
    renderPage(container);
    window.lucide?.createIcons({ el: container });

    const toggle  = container.querySelector('#push-toggle');
    const status  = container.querySelector('#push-status');
    const testBtn = container.querySelector('#push-test-btn');

    if (!pushSupported()) {
      status.textContent = t('settings.pushUnsupported');
      return;
    }

    const applyState = (st) => {
      toggle.checked = st.subscribed;
      toggle.disabled = st.permission === 'denied';
      testBtn.disabled = !st.subscribed;
      if (st.permission === 'denied') status.textContent = t('settings.pushDenied');
      else status.textContent = st.subscribed ? t('settings.pushEnabled') : t('settings.pushDisabled');
    };

    applyState(await pushStatus());

    toggle.addEventListener('change', async () => {
      toggle.disabled = true;
      try {
        const st = toggle.checked ? await enablePush() : await disablePush();
        applyState({ ...await pushStatus(), ...st });
      } catch {
        status.textContent = t('settings.pushError');
        applyState(await pushStatus());
      }
    });

    testBtn.addEventListener('click', async () => {
      testBtn.disabled = true;
      try {
        await api.post('/push/test', {
          title: t('settings.pushTestTitle'),
          body: t('settings.pushTestBody'),
        });
        status.textContent = t('settings.pushTestSent');
      } catch {
        status.textContent = t('settings.pushError');
      } finally {
        testBtn.disabled = false;
      }
    });
  } catch (error) {
    container.replaceChildren();
    throw error;
  }
}
