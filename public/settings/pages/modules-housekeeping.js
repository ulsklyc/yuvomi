import { api } from '/api.js';
import { t } from '/i18n.js';

function renderPage(container, preferences) {
  container.replaceChildren();
  container.insertAdjacentHTML('beforeend', `
    <section class="settings-section">
      <h2 class="settings-section__title">${t('settings.sectionHousekeeping')}</h2>
      <div class="settings-card">
        <h3 class="settings-card__title">${t('settings.housekeepingPaymentsTitle')}</h3>
        <p class="form-hint">${t('settings.housekeepingPaymentTasksHint')}</p>
        <label class="toggle-row">
          <input type="checkbox" id="housekeeping-payment-tasks"${preferences.housekeeping_payment_tasks ? ' checked' : ''}>
          <span>${t('settings.housekeepingPaymentTasksLabel')}</span>
        </label>
      </div>
    </section>
  `);
}

function bindEvents(container) {
  const toggle = container.querySelector('#housekeeping-payment-tasks');
  toggle?.addEventListener('change', async () => {
    toggle.disabled = true;
    try {
      await api.put('/preferences', { housekeeping_payment_tasks: toggle.checked });
      window.oikos?.showToast(t('settings.housekeepingPaymentTasksSaved'), 'success');
    } catch (error) {
      toggle.checked = !toggle.checked;
      window.oikos?.showToast(error.message || t('common.errorGeneric'), 'danger');
    } finally {
      toggle.disabled = false;
    }
  });
}

export async function render(container, { user }) {
  void user;
  const response = await api.get('/preferences');
  const preferences = response?.data ?? {};
  renderPage(container, preferences);
  bindEvents(container);
}
